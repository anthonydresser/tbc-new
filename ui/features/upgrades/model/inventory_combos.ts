// The inventory-combination search for the upgrade finder: for each candidate slot
// swap, every combination of owned (inventory) items swapped into the OTHER slots,
// within hard caps. The upgrade run loop hands each candidate's combo family to one
// `runBulkSim` call, so a weak inventory combo is culled cheaply by the bulk staging
// while the candidate's best survives to full iterations.
import type { BulkGearResult, DistributionMetrics } from '@generated/proto/api';
import { GemColor, type ItemSlot } from '@generated/proto/common';
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
		for (const slot of getEligibleItemSlots(equippedItem.item)) {
			if (!canEquipItem(equippedItem.item, player.getPlayerSpec(), slot)) continue;
			if (baseGear.getEquippedItem(slot)?.item.id === equippedItem.item.id) continue;
			const seen = seenBySlot.get(slot) ?? new Set<number>();
			seenBySlot.set(slot, seen);
			if (seen.has(equippedItem.item.id)) continue;
			seen.add(equippedItem.item.id);
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
const itemsConflict = (a: EquippedItem, b: EquippedItem): boolean =>
	(a.item.unique && a.item.id === b.item.id) || (a.item.limitCategory !== 0 && a.item.limitCategory === b.item.limitCategory);

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
	if (comboGear.getEquippedItem(candidateSlot)?.item.id !== candidateId) return false;
	for (const slot of baseGear.getItemSlots()) {
		if (slot === candidateSlot) continue;
		const swappedItem = swapped.find(([s]) => s === slot)?.[1];
		if (swappedItem) {
			if (comboGear.getEquippedItem(slot)?.item.id !== swappedItem.item.id) return false;
			continue;
		}
		const wore = baseGear.getEquippedItem(slot);
		if ((wore?.item.id ?? null) !== (comboGear.getEquippedItem(slot)?.item.id ?? null)) return false;
	}
	return true;
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
	let totalCombos = 0;
	let truncated = false;

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex];
		const entries: Array<InventoryComboPlanEntry> = [];
		byCandidate.push(entries);

		// Plain swaps for every sim slot come first: when the combo cap cuts the
		// enumeration short, the new results still contain the old behavior's set.
		const simSlots = getUpgradeSimSlots(player, baseGear, candidate);
		for (const slot of simSlots) {
			entries.push({ candidateIndex, slot, gear: buildCandidateGear(candidate, slot), swappedSlots: [] });
			totalCombos++;
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
			for (let combo = 1; entries.length < INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE && totalCombos < INVENTORY_COMBO_MAX_TOTAL; combo++) {
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
				const chosen = picked.filter(p => p.item).map(p => p.item!);
				if (chosen.some(item => itemsConflict(item, candidate.equippedItem))) continue;
				let conflicting = false;
				for (let i = 0; !conflicting && i < chosen.length; i++) {
					for (let j = i + 1; j < chosen.length; j++) {
						if (itemsConflict(chosen[i], chosen[j])) {
							conflicting = true;
							break;
						}
					}
				}
				if (conflicting) continue;

				const swapped = picked.filter(p => p.item !== null).map(p => [p.slot, p.item!] as [ItemSlot, EquippedItem]);
				let comboGear = buildCandidateGear(candidate, slot);
				for (const [swappedSlot, item] of swapped) {
					comboGear = comboGear.withEquippedItem(swappedSlot, item);
				}
				// One fill at the end: authored gems on inventory items survive, only
				// still-empty unfrozen sockets get the fallback gem.
				comboGear = comboGear.fillSocketsWithGems(fallbackGems, frozenSockets);

				if (!isComboIntact(baseGear, comboGear, candidate.spec.id, slot, swapped)) continue;

				entries.push({ candidateIndex, slot, gear: comboGear, swappedSlots: swapped.map(([s]) => s) });
				totalCombos++;
			}
			if (entries.length >= INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE || totalCombos >= INVENTORY_COMBO_MAX_TOTAL) {
				truncated = true;
			}
			if (totalCombos >= INVENTORY_COMBO_MAX_TOTAL) break;
		}
		if (totalCombos >= INVENTORY_COMBO_MAX_TOTAL) break;
	}
	return { byCandidate, totalCombos, truncated, cappedSlots };
};

/**
 * Picks the winning combo of one candidate's bulk run: the highest-average top
 * result mapped back through the plan (`candidateIndex` is our own enumeration
 * index). Returns null when the run produced nothing usable — the caller keeps the
 * candidate out of the results rather than inventing a delta.
 */
export const bestComboResultForCandidate = (
	topResults: Array<BulkGearResult>,
	planEntries: Array<InventoryComboPlanEntry>,
): { entry: InventoryComboPlanEntry; dpsMetrics: DistributionMetrics } | null => {
	let best: { entry: InventoryComboPlanEntry; dpsMetrics: DistributionMetrics } | null = null;
	for (const topResult of topResults) {
		const dpsMetrics = topResult.dpsMetrics;
		if (!dpsMetrics) continue;
		const entry = planEntries[topResult.candidateIndex];
		if (!entry) continue;
		if (!best || dpsMetrics.avg > best.dpsMetrics.avg) best = { entry, dpsMetrics };
	}
	return best;
};
