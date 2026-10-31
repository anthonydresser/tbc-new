import { ArmorType, GemColor, ItemSlot, ItemSpec, ItemType } from '@generated/proto/common';
import type { BulkGearResult } from '@generated/proto/api';
import type { Player } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import type { EquippedItem } from '@sim/proto/equipped_item';
import type { Gear } from '@sim/proto/gear';
import { patchInventoryState, seedInventorySettings } from '@sim/settings/inventory_settings';
import { seedUpgradeSettings } from '@sim/settings/upgrade_settings';
import { createSimStore } from '@sim/state/sim_store';
import type { UpgradeCandidate } from '@sim/upgrade/types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bestComboResultForCandidate,
	collectInventoryOptionsBySlot,
	INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE,
	INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT,
	planInventoryCombos,
} from './inventory_combos';

const F1 = ItemSlot.ItemSlotFinger1;
const F2 = ItemSlot.ItemSlotFinger2;
const T1 = ItemSlot.ItemSlotTrinket1;
const T2 = ItemSlot.ItemSlotTrinket2;
const HEAD = ItemSlot.ItemSlotHead;

let player: Player<any>;
let itemDefs: Record<number, { type: ItemType; unique?: boolean; limitCategory?: number; classAllowlist?: number[] }>;

// Minimal fake Gear covering exactly the surface the planner uses; swaps never
// silently clear other slots (the intact check is exercised directly instead).
type FakeGear = Gear & { slots: Map<ItemSlot, EquippedItem>; fillCount: number };
const fakeGearOf = (worn: Array<[ItemSlot, EquippedItem]>, fillCount = 0): FakeGear => {
	const gear = {
		slots: new Map(worn),
		fillCount,
		getItemSlots: () => [...gear.slots.keys()],
		getEquippedItem: (slot: ItemSlot) => gear.slots.get(slot) ?? null,
		withEquippedItem: (slot: ItemSlot, item: EquippedItem | null) => {
			const pairs: Array<[ItemSlot, EquippedItem]> = [...gear.slots];
			const next = fakeGearOf(pairs.filter(([s]) => s !== slot), gear.fillCount);
			if (item !== null) next.slots.set(slot, item);
			return next;
		},
		fillSocketsWithGems: () => fakeGearOf([...gear.slots], gear.fillCount + 1),
	} as unknown as FakeGear;
	return gear;
};

const fakeEquippedItemOf = (id: number): EquippedItem => {
	const def = itemDefs[id];
	const equippedItem = {
		asSpec: () => ItemSpec.create({ id }),
		item: {
			id,
			name: `Item ${id}`,
			type: def.type,
			armorType: ArmorType.ArmorTypeCloth,
			classAllowlist: def.classAllowlist ?? [],
			unique: def.unique ?? false,
			limitCategory: def.limitCategory ?? 0,
		},
		withDynamicStats: () => equippedItem,
	};
	return equippedItem as unknown as EquippedItem;
};

const candidateOf = (id: number): UpgradeCandidate => ({
	spec: ItemSpec.create({ id }),
	equippedItem: fakeEquippedItemOf(id),
	selectedEnchant: null,
});

const NO_FILL = new Map<GemColor, null>();

beforeEach(() => {
	const store = createSimStore();
	itemDefs = {};
	const fakeDb = {
		lookupItemSpec: (spec: ItemSpec) => (itemDefs[spec.id] ? fakeEquippedItemOf(spec.id) : null),
	};
	player = {
		storeKey: 0,
		sim: { store, db: fakeDb },
		getPlayerSpec: () => PlayerSpecs.DpsWarrior,
	} as unknown as Player<any>;
	seedInventorySettings(player);
	seedUpgradeSettings(player);
});

const own = (ids: Array<number>) => {
	for (const id of ids) {
		if (!itemDefs[id]) itemDefs[id] = { type: ItemType.ItemTypeFinger };
	}
	patchInventoryState(player, { items: ids.map(id => ItemSpec.create({ id })) }, ['items']);
};

describe('collectInventoryOptionsBySlot', () => {
	it('offers a ring for both finger slots when nothing worn matches', () => {
		own([100]);
		const { optionsBySlot, cappedSlots } = collectInventoryOptionsBySlot(player, fakeGearOf([]));
		expect(optionsBySlot.get(F1)!.map(o => o.item.id)).toEqual([100]);
		expect(optionsBySlot.get(F2)!.map(o => o.item.id)).toEqual([100]);
		expect(cappedSlots).toEqual([]);
	});

	it('excludes the worn copy from its slot but keeps the other finger', () => {
		own([100]);
		const { optionsBySlot } = collectInventoryOptionsBySlot(player, fakeGearOf([[F1, fakeEquippedItemOf(100)]]));
		expect(optionsBySlot.get(F1) ?? []).toEqual([]);
		expect(optionsBySlot.get(F2)!.map(o => o.item.id)).toEqual([100]);
	});

	it('dedupes repeated ids, keeping the first entry', () => {
		own([100, 100]);
		const { optionsBySlot } = collectInventoryOptionsBySlot(player, fakeGearOf([]));
		expect(optionsBySlot.get(F1)!.length).toBe(1);
	});

	it('drops class-locked items', () => {
		itemDefs[100] = { type: ItemType.ItemTypeFinger, classAllowlist: [999] };
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		expect(collectInventoryOptionsBySlot(player, fakeGearOf([])).optionsBySlot.get(F1) ?? []).toEqual([]);
	});

	it('caps the slot list and reports capped slots', () => {
		const ids = Array.from({ length: INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT + 2 }, (_, i) => 100 + i);
		own(ids);
		const { optionsBySlot, cappedSlots } = collectInventoryOptionsBySlot(player, fakeGearOf([]));
		expect(optionsBySlot.get(F1)!.length).toBe(INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT);
		expect(cappedSlots).toContain(F1);
		expect(cappedSlots).toContain(F2);
	});
});

describe('planInventoryCombos', () => {
	// Plain-swap builder: candidate item replaces the slot, no fallback fill (so
	// each produced combo has fillCount === 1, plain swaps 0).
	const buildCandidateGear = (baseGear: Gear) => (candidate: UpgradeCandidate, slot: ItemSlot) =>
		baseGear.withEquippedItem(slot, candidate.equippedItem) as FakeGear;

	it('without an inventory, collapses interchangeable plain swaps to one', () => {
		itemDefs[200] = { type: ItemType.ItemTypeTrinket };
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL);
		// T1 and T2 plain swaps are the same gear set; the first orientation wins.
		expect(plan.totalCombos).toBe(1);
		expect(plan.byCandidate[0].map(e => [e.slot, e.swappedSlots])).toEqual([[T1, []]]);
		expect(plan.truncated).toBe(false);
	});

	it('produces one combo per inventory option for a head candidate', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[201] = { type: ItemType.ItemTypeHead };
		own([100]); // one ring
		const baseGear = fakeGearOf([[HEAD, fakeEquippedItemOf(201)]]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL);
		// plain + ring-in-one-finger (F2 orientation wins; F1 is the same set) + the
		// same (non-unique) ring in both fingers
		expect(plan.byCandidate[0].length).toBe(3);
		expect(plan.byCandidate[0][0].swappedSlots).toEqual([]);
		expect(plan.byCandidate[0].slice(1).map(e => e.swappedSlots)).toEqual([[F2], [F1, F2]]);
		for (const entry of plan.byCandidate[0].slice(1)) {
			expect((entry.gear as FakeGear).fillCount).toBe(1);
		}
	});

	it('cross-products two rings per finger and skips the all-no-op position', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		own([100, 101]); // two non-unique rings
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL);
		// plain + unordered ring multisets: {100}, {101}, {100,100}, {100,101}, {101,101}
		expect(plan.byCandidate[0].length).toBe(6);
		expect(plan.byCandidate[0].some(e => e.swappedSlots.length === 2)).toBe(true);
	});

	it('allows the same non-unique ring in both fingers but skips a unique ring doubled up', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[100] = { type: ItemType.ItemTypeFinger };
		itemDefs[101] = { type: ItemType.ItemTypeFinger, unique: true };
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 }), ItemSpec.create({ id: 101 })] }, ['items']);
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL);
		const doubled = plan.byCandidate[0].filter(e => {
			const gear = (e as { gear: Gear }).gear as FakeGear;
			return e.swappedSlots.length === 2 && gear.slots.get(F1)?.item.id === gear.slots.get(F2)?.item.id;
		});
		expect(doubled.map(e => (e.gear as FakeGear).slots.get(F1)!.item.id)).toEqual([100]);
	});

	it('skips combos where a chosen item conflicts with the candidate', () => {
		itemDefs[100] = { type: ItemType.ItemTypeFinger, unique: true };
		own([100]);
		const baseGear = fakeGearOf([]);
		// Candidate IS the same unique ring: candidate slot occupied by it, so swapping
		// the other finger to the same id must not appear.
		const planF1 = planInventoryCombos(player, baseGear, [candidateOf(100)], buildCandidateGear(baseGear), NO_FILL);
		expect(planF1.byCandidate[0].map(e => [e.slot, e.swappedSlots])).toEqual([[F1, []]]);
	});

	it('skips combos conflicting on a shared limit category', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[100] = { type: ItemType.ItemTypeFinger, limitCategory: 7 };
		itemDefs[101] = { type: ItemType.ItemTypeFinger, limitCategory: 7 };
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 }), ItemSpec.create({ id: 101 })] }, ['items']);
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL);
		// No combo may carry both ids.
		for (const entry of plan.byCandidate[0]) {
			const gear = entry.gear as FakeGear;
			const ids = [gear.slots.get(F1)?.item.id, gear.slots.get(F2)?.item.id].filter(Boolean);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it('does not offer candidate-slot options while the candidate occupies it', () => {
		// Non-unique ring candidate, same ring owned: plain swap in each finger, plus
		// the owned copy in the OTHER finger — but never a second swap of the slot the
		// candidate itself occupies.
		own([100]);
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(100)], buildCandidateGear(baseGear), NO_FILL);
		// The second finger's orientations are the same gear sets and dedupe away.
		expect(plan.byCandidate[0].map(e => [e.slot, e.swappedSlots])).toEqual([
			[F1, []],
			[F1, [F2]],
		]);
	});

	it('caps combos per candidate and flags truncation', () => {
		itemDefs[500] = { type: ItemType.ItemTypeHead };
		// 8 rings and 8 trinkets across 4 slots: 9^4 cross-product positions.
		const ids = Array.from({ length: 16 }, (_, i) => 100 + i);
		for (let i = 0; i < ids.length; i++) itemDefs[ids[i]] = { type: i < 8 ? ItemType.ItemTypeFinger : ItemType.ItemTypeTrinket };
		patchInventoryState(player, { items: ids.map(id => ItemSpec.create({ id })) }, ['items']);
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(500)], buildCandidateGear(baseGear), NO_FILL);
		expect(plan.byCandidate[0].length).toBe(INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE);
		expect(plan.truncated).toBe(true);
	});

	it('is deterministic across identical calls', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		patchInventoryState(player, { items: [100, 101, 102].map(id => ItemSpec.create({ id })) }, ['items']);
		const baseGear = fakeGearOf([]);
		const fingerprint = (plan: ReturnType<typeof planInventoryCombos>) =>
			plan.byCandidate.map(entries => entries.map(e => [e.slot, e.swappedSlots, ...[...((e.gear as FakeGear).slots.values())].map(i => i.item.id)]));
		expect(fingerprint(planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL))).toEqual(
			fingerprint(planInventoryCombos(player, baseGear, [candidateOf(200)], buildCandidateGear(baseGear), NO_FILL)),
		);
	});

	it('produces nothing for a candidate with no valid sim slots', () => {
		itemDefs[100] = { type: ItemType.ItemTypeFinger, unique: true };
		own([]);
		const baseGear = fakeGearOf([[F1, fakeEquippedItemOf(100)]]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(100)], buildCandidateGear(baseGear), NO_FILL);
		expect(plan.byCandidate[0]).toEqual([]);
	});
});

describe('bestComboResultForCandidate', () => {
	const topOf = (candidateIndex: number, avg: number): BulkGearResult => ({ candidateIndex, dpsMetrics: { avg } }) as unknown as BulkGearResult;

	it('picks the highest-average combo and maps it back to the plan entry', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		own([100]);
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
		const entries = plan.byCandidate[0];
		const best = bestComboResultForCandidate([topOf(0, 10), topOf(2, 99), topOf(1, 50)], entries);
		expect(best!.entry).toBe(entries[2]);
		expect(best!.dpsMetrics.avg).toBe(99);
	});

	it('ignores results that resolve to no plan entry or metrics, and tolerates emptiness', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
		expect(bestComboResultForCandidate([], plan.byCandidate[0])).toBeNull();
		expect(bestComboResultForCandidate([topOf(99, 10)], plan.byCandidate[0])).toBeNull();
	});
});
