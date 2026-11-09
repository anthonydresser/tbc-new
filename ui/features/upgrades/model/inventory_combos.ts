// The inventory-combination search for the upgrade finder: for each candidate slot
// swap, every combination of owned (inventory) items swapped into the OTHER slots,
// within hard caps. The upgrade run loop hands each candidate's combo family to one
// `runBulkSim` call, so a weak inventory combo is culled cheaply by the bulk staging
// while the candidate's best survives to full iterations.
import type { BulkGearResult, DistributionMetrics } from '@generated/proto/api';
import { EquipmentSpec, GemColor, HandType, ItemSlot, ItemSpec } from '@generated/proto/common';
import type { UIGem as Gem } from '@generated/proto/ui';
import type { Player } from '@sim/player/player';
import type { EquippedItem } from '@sim/proto/equipped_item';
import type { Gear } from '@sim/proto/gear';
import { canEquipItem, getEligibleItemSlots } from '@sim/proto/items';
import { inventoryItems } from '@sim/settings/inventory_settings';
import type { UpgradeCandidate } from '@sim/upgrade/types';

import { getUpgradeSimSlots } from './items';

// Hard caps, the guardrail on the cross-product explosion.
export const INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT = 8;
export const INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE = 64;
export const INVENTORY_COMBO_MAX_TOTAL = 500;
// Raw cross-product positions examined per candidate before giving up, even when
// conflicts/skips kept the produced count low (conflicting items can make the
// family large while producing nothing).
export const INVENTORY_COMBO_MAX_SCANS_PER_CANDIDATE = 512;

// Fingers are interchangeable, as are trinkets: ring A in Finger1 + ring B in
// Finger2 sims the exact same gear set as A in Finger2 + B in Finger1. Combos that
// differ only in the ordering inside one of these pairs collapse to one entry.
const INTERCHANGEABLE_SLOTS: ReadonlyArray<ReadonlyArray<ItemSlot>> = [
	[ItemSlot.ItemSlotFinger1, ItemSlot.ItemSlotFinger2],
	[ItemSlot.ItemSlotTrinket1, ItemSlot.ItemSlotTrinket2],
];

/**
 * Canonical identity of a combo independent of interchangeable slot order: per
 * interchangeable group, the sorted list of item specs in the group; every other
 * slot contributes a slot-keyed entry. Two combos with the same key are one sim.
 */
const comboIdentityKey = (gear: Gear): string => {
	const interchangeable = new Set<ItemSlot>(INTERCHANGEABLE_SLOTS.flatMap(group => [...group]));
	const itemKey = (slot: ItemSlot): string => {
		const item = gear.getEquippedItem(slot);
		return item ? ItemSpec.toJsonString(item.asSpec()) : 'empty';
	};
	const parts: Array<string> = INTERCHANGEABLE_SLOTS.map(group => group.map(itemKey).sort().join('&'));
	for (const slot of gear.getItemSlots()) {
		if (interchangeable.has(slot)) continue;
		parts.push(`${slot}:${itemKey(slot)}`);
	}
	return parts.join('|');
};

export interface InventoryComboPlanEntry {
	candidateIndex: number;
	// The slot the candidate swaps into.
	slot: ItemSlot;
	gear: Gear;
	// Additional slots the combo changed via inventory items (empty for the plain swap).
	swappedSlots: Array<ItemSlot>;
}

export interface InventoryComboPlan {
	// Index-aligned with the candidates array; entry [0] of a non-empty family is
	// always the plain single swap, so the new results are a superset of the old.
	byCandidate: Array<Array<InventoryComboPlanEntry>>;
	totalCombos: number;
	// A per-candidate or total cap cut the search short.
	truncated: boolean;
	// Slots whose inventory option list hit the per-slot cap.
	cappedSlots: Array<ItemSlot>;
}

/**
 * Owned items offered per slot: resolved with their authored enchant/gems/suffix,
 * deduped by id, excluding the copy already worn in that slot (a second copy of a
 * non-unique ring stays eligible for the other Finger). Deterministic order.
 */
export const collectInventoryOptionsBySlot = (
	player: Player<any>,
	baseGear: Gear,
): { optionsBySlot: Map<ItemSlot, Array<EquippedItem>>; cappedSlots: Array<ItemSlot> } => {
	const optionsBySlot = new Map<ItemSlot, Array<EquippedItem>>();
	const cappedSlots: Array<ItemSlot> = [];
	const seenBySlot = new Map<ItemSlot, Set<number>>();

	for (const spec of inventoryItems(player)) {
		const equippedItem = player.sim.db.lookupItemSpec(spec)?.withDynamicStats();
		if (!equippedItem) continue;
		// `_item` instead of the `item` getter: these are read-only identity/eligibility
		// checks, and the getter's defensive proto clone made this loop (and the
		// enumeration below) the dominant cost of a gear-set switch.
		const item = equippedItem._item;
		for (const slot of getEligibleItemSlots(item)) {
			if (!canEquipItem(item, player.getPlayerSpec(), slot)) continue;
			if (baseGear.getEquippedItem(slot)?.id === item.id) continue;
			const seen = seenBySlot.get(slot) ?? new Set<number>();
			seenBySlot.set(slot, seen);
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			const options = optionsBySlot.get(slot) ?? [];
			optionsBySlot.set(slot, options);
			if (options.length >= INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT) {
				if (!cappedSlots.includes(slot)) cappedSlots.push(slot);
				continue;
			}
			options.push(equippedItem);
		}
	}
	return { optionsBySlot, cappedSlots };
};

// Two items can't share a gear set when they are the same unique item, or are bound
// to the same limit category (weapon-effect groups). `withEquippedItem` would
// otherwise silently clear the conflicting slot and sim a set with an empty slot.
// `_item` instead of the cloning `item` getter — read-only identity checks.
const itemsConflict = (a: EquippedItem, b: EquippedItem): boolean =>
	(a._item.unique && a._item.id === b._item.id) || (a._item.limitCategory !== 0 && a._item.limitCategory === b._item.limitCategory);

/**
 * Sanity-checks a built combo: the intended items are in place and no other slot
 * lost or swapped its item. Catches silent clears from two-handler/weapon-combo
 * validation inside `withEquippedItemInternal`. (Gem-stripping from unique gems is
 * expected and allowed through.)
 */
export const isComboIntact = (
	baseGear: Gear,
	comboGear: Gear,
	candidateId: number,
	candidateSlot: ItemSlot,
	swapped: Array<[ItemSlot, EquippedItem]>,
): boolean => {
	if (comboGear.getEquippedItem(candidateSlot)?.id !== candidateId) return false;
	for (const slot of baseGear.getItemSlots()) {
		if (slot === candidateSlot) continue;
		const swappedItem = swapped.find(([s]) => s === slot)?.[1];
		if (swappedItem) {
			if (comboGear.getEquippedItem(slot)?.id !== swappedItem.id) return false;
			continue;
		}
		const wore = baseGear.getEquippedItem(slot);
		if ((wore?.id ?? null) !== (comboGear.getEquippedItem(slot)?.id ?? null)) return false;
	}
	return true;
};

/**
 * The enumeration shared by the planner (`planInventoryCombos`, which builds gear
 * sets) and the render-time counter (`countInventoryCombos`, which only counts) —
 * one iterator so the two can never drift apart. Per candidate: plain swaps for
 * every sim slot first, then the mixed-radix cross product of inventory options on
 * the other slots, rejecting positions with uniqueness/limit-category conflicts,
 * all under the INVENTORY_COMBO_MAX_* caps. The hooks consume each position and
 * report whether it counted, which is what the caps see.
 */
const enumerateComboPositions = (
	candidates: Array<UpgradeCandidate>,
	optionsBySlot: Map<ItemSlot, Array<EquippedItem>>,
	simSlotsFor: (candidate: UpgradeCandidate) => Array<ItemSlot>,
	hooks: {
		beginCandidate: (candidateIndex: number, candidate: UpgradeCandidate) => void;
		acceptPlain: (candidateIndex: number, slot: ItemSlot) => boolean;
		acceptCombo: (candidateIndex: number, slot: ItemSlot, chosen: Array<{ slot: ItemSlot; item: EquippedItem }>) => boolean;
	},
): { totalCombos: number; truncated: boolean } => {
	let totalCombos = 0;
	let truncated = false;

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		hooks.beginCandidate(candidateIndex, candidate);
		const simSlots = simSlotsFor(candidate);

		// Plain swaps first: when the combo cap cuts the enumeration short, the
		// accepted set still contains the old single-swap behavior.
		let accepted = 0;
		for (const slot of simSlots) {
			if (hooks.acceptPlain(candidateIndex, slot)) {
				accepted++;
				totalCombos++;
			}
		}

		for (const slot of simSlots) {
			// Inventory choices for every slot that has options and isn't the
			// candidate's own. An empty choice matrix means just the plain swap.
			const choiceSlots: Array<Array<{ slot: ItemSlot; item: EquippedItem | null }>> = [];
			for (const [otherSlot, options] of optionsBySlot) {
				if (otherSlot === slot) continue;
				choiceSlots.push([{ slot: otherSlot, item: null }, ...options.map(item => ({ slot: otherSlot, item }))]);
			}
			if (!choiceSlots.length) continue;

			// Mixed-radix enumeration of the cross product, skipping the all-no-op
			// position (that IS the plain swap) and stopping at the caps.
			const digits = choiceSlots.map(choices => choices.length);
			for (let combo = 1; accepted < INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE && totalCombos < INVENTORY_COMBO_MAX_TOTAL; combo++) {
				if (combo > INVENTORY_COMBO_MAX_SCANS_PER_CANDIDATE) {
					truncated = true;
					break;
				}
				let remainder = combo;
				const picked: Array<{ slot: ItemSlot; item: EquippedItem | null }> = new Array(digits.length);
				for (let d = digits.length - 1; d >= 0; d--) {
					picked[d] = choiceSlots[d][remainder % digits[d]];
					remainder = Math.floor(remainder / digits[d]);
				}
				if (remainder !== 0) break; // wrapped past the highest radix: product exhausted

				// Uniqueness/limit-category conflicts among the candidate and the
				// chosen inventory items disqualify the combo outright.
				const chosenItems = picked.filter(p => p.item !== null).map(p => p.item!);
				if (chosenItems.some(item => itemsConflict(item, candidate.equippedItem))) continue;
				let conflicting = false;
				for (let i = 0; !conflicting && i < chosenItems.length; i++) {
					for (let j = i + 1; j < chosenItems.length; j++) {
						if (itemsConflict(chosenItems[i], chosenItems[j])) {
							conflicting = true;
							break;
						}
					}
				}
				if (conflicting) continue;

				if (hooks.acceptCombo(candidateIndex, slot, picked.filter(p => p.item !== null) as Array<{ slot: ItemSlot; item: EquippedItem }>)) {
					accepted++;
					totalCombos++;
				}
			}
			if (accepted >= INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE || totalCombos >= INVENTORY_COMBO_MAX_TOTAL) {
				truncated = true;
			}
			if (totalCombos >= INVENTORY_COMBO_MAX_TOTAL) break;
		}
		if (totalCombos >= INVENTORY_COMBO_MAX_TOTAL) break;
	}
	return { totalCombos, truncated };
};

/**
 * Builds the combo plan for a run: for every candidate and every slot it can
 * actually sim in (`getUpgradeSimSlots`), entry [0] is the plain swap and the rest
 * are cross products of inventory options on the other slots, one socket fill each.
 *
 * `buildCandidateGear(candidate, slot)` is the injected plain-swap builder
 * (`buildUpgradeCandidateGear` with fallback-gem fill) so this module stays
 * unit-testable without a host.
 */
export const planInventoryCombos = (
	player: Player<any>,
	baseGear: Gear,
	candidates: Array<UpgradeCandidate>,
	buildCandidateGear: (candidate: UpgradeCandidate, slot: ItemSlot) => Gear,
	fallbackGems: Map<GemColor, Gem | null>,
	frozenSockets?: Set<string>,
): InventoryComboPlan => {
	const { optionsBySlot, cappedSlots } = collectInventoryOptionsBySlot(player, baseGear);
	const byCandidate: Array<Array<InventoryComboPlanEntry>> = [];
	let entries: Array<InventoryComboPlanEntry> = [];
	// Seen gear sets of this family; interchangeable slot pairs never double-sim.
	let seenComboKeys = new Set<string>();

	const record = (candidateIndex: number, slot: ItemSlot, gear: Gear, swappedSlots: Array<ItemSlot>): boolean => {
		const key = comboIdentityKey(gear);
		if (seenComboKeys.has(key)) return false;
		seenComboKeys.add(key);
		entries.push({ candidateIndex, slot, gear, swappedSlots });
		return true;
	};

	const { totalCombos, truncated } = enumerateComboPositions(candidates, optionsBySlot, candidate => getUpgradeSimSlots(player, baseGear, candidate), {
		beginCandidate: candidateIndex => {
			entries = [];
			byCandidate[candidateIndex] = entries;
			seenComboKeys = new Set<string>();
		},
		acceptPlain: (candidateIndex, slot) => record(candidateIndex, slot, buildCandidateGear(candidates[candidateIndex], slot), []),
		acceptCombo: (candidateIndex, slot, chosen) => {
			const candidate = candidates[candidateIndex];
			let comboGear = buildCandidateGear(candidate, slot);
			for (const { slot: swappedSlot, item } of chosen) {
				comboGear = comboGear.withEquippedItem(swappedSlot, item);
			}
			// One fill at the end: authored gems on inventory items survive, only
			// still-empty unfrozen sockets get the fallback gem.
			comboGear = comboGear.fillSocketsWithGems(fallbackGems, frozenSockets);

			const swapped = chosen.map(c => [c.slot, c.item] as [ItemSlot, EquippedItem]);
			if (!isComboIntact(baseGear, comboGear, candidate.spec.id, slot, swapped)) return false;

			// Interchangeable pair permutations of an already-planned set are the
			// same sim (e.g. candidate in Finger1 + owned ring in Finger2 vs. the
			// reverse); the first encountered orientation wins.
			return record(
				candidateIndex,
				slot,
				comboGear,
				chosen.map(c => c.slot),
			);
		},
	});
	return { byCandidate, totalCombos, truncated, cappedSlots };
};

// Identity-only view of an equipped item for the counting pass, read straight off
// the underlying proto — the `item` getter returns a defensive clone, and the
// counter runs synchronously in render on every gear change.
interface SlotOccupancy {
	id: number;
	unique: boolean;
	limitCategory: number;
	handType: HandType;
}
const occupancyOf = (item: EquippedItem | null | undefined): SlotOccupancy | null => {
	if (!item) return null;
	const proto = item._item;
	return { id: proto.id, unique: proto.unique, limitCategory: proto.limitCategory, handType: proto.handType };
};

// Mirrors Gear.withEquippedItemInternal (gear.ts) at the item-id level: unique /
// limit-category clears BEFORE the assignment, weapon-combo validation AFTER.
const simulateSwap = (occupancy: Map<ItemSlot, SlotOccupancy | null>, slot: ItemSlot, next: SlotOccupancy): void => {
	if (next.unique || next.limitCategory !== 0) {
		for (const [otherSlot, worn] of occupancy) {
			if (worn !== null && ((next.limitCategory !== 0 && worn.limitCategory === next.limitCategory) || (next.unique && worn.id === next.id))) {
				occupancy.set(otherSlot, null);
			}
		}
	}
	occupancy.set(slot, next);

	const mainHand = occupancy.get(ItemSlot.ItemSlotMainHand) ?? null;
	const offHand = occupancy.get(ItemSlot.ItemSlotOffHand) ?? null;
	// !validWeaponCombo: either hand holding a two-hander invalidates the pair.
	if (mainHand?.handType === HandType.HandTypeTwoHand || offHand?.handType === HandType.HandTypeTwoHand) {
		if (slot === ItemSlot.ItemSlotOffHand) {
			if (offHand?.handType === HandType.HandTypeTwoHand) occupancy.set(ItemSlot.ItemSlotOffHand, null);
			occupancy.set(ItemSlot.ItemSlotMainHand, null);
		} else {
			occupancy.set(ItemSlot.ItemSlotOffHand, null);
		}
	}
};

// Clone-free comboIdentityKey equivalent: same interchangeable-pair collapse, but
// per-slot bare ids. Per-slot inventory options are deduped by id
// (collectInventoryOptionsBySlot), so within one candidate's enumeration a slot id
// pins the authored spec — ids alone carry the same distinguishment.
const comboOccupancyKey = (occupancy: Map<ItemSlot, SlotOccupancy | null>, slots: Array<ItemSlot>): string => {
	const interchangeable = new Set<ItemSlot>(INTERCHANGEABLE_SLOTS.flatMap(group => [...group]));
	const idAt = (slot: ItemSlot): string => `${occupancy.get(slot)?.id ?? 0}`;
	const parts: Array<string> = INTERCHANGEABLE_SLOTS.map(group => group.map(idAt).sort().join('&'));
	for (const slot of slots) {
		if (interchangeable.has(slot)) continue;
		parts.push(`${slot}:${idAt(slot)}`);
	}
	return parts.join('|');
};

/**
 * Counts the exact combinations `planInventoryCombos` would enumerate, without
 * materializing any Gear/EquippedItem protos: slot occupancy is simulated at the
 * item-id level (`simulateSwap` replicates the planner's slot-clearing rules), and
 * identity keys are id strings. Backs the always-rendered sim-count label, where
 * building hundreds of gear sets on every gear change froze the UI for seconds.
 */
export const countInventoryCombos = (player: Player<any>, baseGear: Gear, candidates: Array<UpgradeCandidate>): number => {
	const { optionsBySlot } = collectInventoryOptionsBySlot(player, baseGear);
	const slots = baseGear.getItemSlots();
	const baseOccupancy = new Map<ItemSlot, SlotOccupancy | null>(slots.map(slot => [slot, occupancyOf(baseGear.getEquippedItem(slot))]));
	let candidateOccupancy: SlotOccupancy | null = null;
	let seenComboKeys = new Set<string>();

	return enumerateComboPositions(candidates, optionsBySlot, candidate => getUpgradeSimSlots(player, baseGear, candidate), {
		beginCandidate: (_candidateIndex, candidate) => {
			candidateOccupancy = occupancyOf(candidate.equippedItem);
			seenComboKeys = new Set<string>();
		},
		acceptPlain: (_candidateIndex, slot) => {
			const occupancy = new Map(baseOccupancy);
			simulateSwap(occupancy, slot, candidateOccupancy!);
			const key = comboOccupancyKey(occupancy, slots);
			if (seenComboKeys.has(key)) return false;
			seenComboKeys.add(key);
			return true;
		},
		acceptCombo: (_candidateIndex, slot, chosen) => {
			const occupancy = new Map(baseOccupancy);
			simulateSwap(occupancy, slot, candidateOccupancy!);
			for (const { slot: swappedSlot, item } of chosen) {
				simulateSwap(occupancy, swappedSlot, occupancyOf(item)!);
			}
			// Same sanity check as isComboIntact: every intended item is in place and
			// every untouched slot kept its base item.
			if (occupancy.get(slot)?.id !== candidateOccupancy!.id) return false;
			for (const otherSlot of slots) {
				if (otherSlot === slot) continue;
				const chosenItem = chosen.find(c => c.slot === otherSlot)?.item;
				if (chosenItem) {
					if (occupancy.get(otherSlot)?.id !== chosenItem.id) return false;
					continue;
				}
				if ((occupancy.get(otherSlot)?.id ?? null) !== (baseOccupancy.get(otherSlot)?.id ?? null)) return false;
			}
			const key = comboOccupancyKey(occupancy, slots);
			if (seenComboKeys.has(key)) return false;
			seenComboKeys.add(key);
			return true;
		},
	}).totalCombos;
};

/**
 * Picks the winning combo of one candidate's bulk run: the highest-average top
 * result mapped back through the plan (`candidateIndex` is our own enumeration
 * index). Returns null when the run produced nothing usable — the caller keeps the
 * candidate out of the results rather than inventing a delta.
 *
 * `optimizedSpec` is the backend's gear for the winning combo: with the gem
 * pre-pass on it carries the re-gemmed set (and without it, what was submitted).
 * Either way its enchants were run through `Sim.prepareGear`, which strips ring
 * enchants for non-enchanters, so consumers restoring it must copy the enchants
 * back from the plan entry's gear.
 */
export const bestComboResultForCandidate = (
	topResults: Array<BulkGearResult>,
	planEntries: Array<InventoryComboPlanEntry>,
): { entry: InventoryComboPlanEntry; dpsMetrics: DistributionMetrics; optimizedSpec: EquipmentSpec | undefined } | null => {
	let best: { entry: InventoryComboPlanEntry; dpsMetrics: DistributionMetrics; optimizedSpec: EquipmentSpec | undefined } | null = null;
	for (const topResult of topResults) {
		const dpsMetrics = topResult.dpsMetrics;
		if (!dpsMetrics) continue;
		const entry = planEntries[topResult.candidateIndex];
		if (!entry) continue;
		if (!best || dpsMetrics.avg > best.dpsMetrics.avg) best = { entry, dpsMetrics, optimizedSpec: topResult.gear };
	}
	return best;
};
