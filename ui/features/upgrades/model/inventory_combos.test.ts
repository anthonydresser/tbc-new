import type { BulkGearResult } from '@generated/proto/api';
import { ArmorType, GemColor, HandType, ItemSlot, ItemSpec, ItemType, WeaponType } from '@generated/proto/common';
import { UIItem } from '@generated/proto/ui';
import type { Player } from '@sim/player/player';
import { PlayerSpecs } from '@sim/player/specs';
import { EquippedItem } from '@sim/proto/equipped_item';
import { Gear } from '@sim/proto/gear';
import { patchInventoryState, seedInventorySettings } from '@sim/settings/inventory_settings';
import { seedUpgradeSettings } from '@sim/settings/upgrade_settings';
import { createSimStore } from '@sim/state/sim_store';
import type { UpgradeCandidate } from '@sim/upgrade/types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bestComboResultForCandidate,
	collectInventoryOptionsBySlot,
	countInventoryCombos,
	INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE,
	INVENTORY_COMBO_MAX_OPTIONS_PER_SLOT,
	planInventoryCombos,
} from './inventory_combos';

const F1 = ItemSlot.ItemSlotFinger1;
const F2 = ItemSlot.ItemSlotFinger2;
const T1 = ItemSlot.ItemSlotTrinket1;
const HEAD = ItemSlot.ItemSlotHead;

let player: Player<any>;
let itemDefs: Record<
	number,
	{ type: ItemType; unique?: boolean; limitCategory?: number; classAllowlist?: number[]; handType?: HandType; weaponType?: WeaponType }
>;

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
			const next = fakeGearOf(
				pairs.filter(([s]) => s !== slot),
				gear.fillCount,
			);
			if (item !== null) next.slots.set(slot, item);
			return next;
		},
		fillSocketsWithGems: () => fakeGearOf([...gear.slots], gear.fillCount + 1),
	} as unknown as FakeGear;
	return gear;
};

const fakeEquippedItemOf = (id: number): EquippedItem => {
	const def = itemDefs[id];
	// `_item` is read directly by the planner/counter's identity checks (they skip
	// the `item` getter's defensive proto clone); keep them the same object here.
	const item = {
		id,
		name: `Item ${id}`,
		type: def.type,
		armorType: ArmorType.ArmorTypeCloth,
		classAllowlist: def.classAllowlist ?? [],
		unique: def.unique ?? false,
		limitCategory: def.limitCategory ?? 0,
		handType: def.handType ?? HandType.HandTypeUnknown,
	};
	const equippedItem = {
		id,
		asSpec: () => ItemSpec.create({ id }),
		item,
		_item: item,
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
			plan.byCandidate.map(entries => entries.map(e => [e.slot, e.swappedSlots, ...[...(e.gear as FakeGear).slots.values()].map(i => i.item.id)]));
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

	it('carries the winning result gear through as the optimized spec', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
		const gear = { marker: true };
		const best = bestComboResultForCandidate([{ ...topOf(0, 99), gear } as unknown as BulkGearResult], plan.byCandidate[0]);
		expect(best!.optimizedSpec).toBe(gear);
	});

	it('ignores results that resolve to no plan entry or metrics, and tolerates emptiness', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		const baseGear = fakeGearOf([]);
		const plan = planInventoryCombos(player, baseGear, [candidateOf(200)], (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
		expect(bestComboResultForCandidate([], plan.byCandidate[0])).toBeNull();
		expect(bestComboResultForCandidate([topOf(99, 10)], plan.byCandidate[0])).toBeNull();
	});
});

describe('countInventoryCombos matches planInventoryCombos', () => {
	// REAL EquippedItem/Gear protos: `withEquippedItem`'s slot-clear rules (uniques,
	// limit categories, two-hand weapon combos) only execute in the real classes —
	// the fakes above never clear slots. The counter reproduces those rules at the
	// item-id level, so equivalence has to be proven against the real classes.
	const MH = ItemSlot.ItemSlotMainHand;
	const OH = ItemSlot.ItemSlotOffHand;

	const realEquippedItemOf = (id: number): EquippedItem => {
		const def = itemDefs[id];
		return new EquippedItem({
			item: UIItem.create({
				id,
				name: `Item ${id}`,
				icon: 'inv_misc_questionmark',
				type: def.type,
				weaponType: def.weaponType ?? WeaponType.WeaponTypeUnknown,
				handType: def.handType ?? HandType.HandTypeUnknown,
				armorType: ArmorType.ArmorTypeCloth,
				classAllowlist: def.classAllowlist ?? [],
				unique: def.unique ?? false,
				limitCategory: def.limitCategory ?? 0,
				scalingOptions: [{}],
			}),
		});
	};

	const realGearOf = (worn: Array<[ItemSlot, number]>): Gear => {
		const internal: Partial<Record<ItemSlot, EquippedItem | null>> = {};
		for (const [slot, id] of worn) internal[slot] = realEquippedItemOf(id);
		return new Gear(internal);
	};

	const realCandidateOf = (id: number): UpgradeCandidate => ({
		spec: ItemSpec.create({ id }),
		equippedItem: realEquippedItemOf(id),
		selectedEnchant: null,
	});

	beforeEach(() => {
		// The shared player's db resolves ItemSpecs into fakes; this suite needs the
		// real EquippedItem machinery.
		(player.sim as unknown as { db: unknown }).db = {
			lookupItemSpec: (spec: ItemSpec) => (itemDefs[spec.id] ? realEquippedItemOf(spec.id) : null),
		};
	});

	const ownReal = (ids: Array<number>) => {
		patchInventoryState(player, { items: ids.map(id => ItemSpec.create({ id })) }, ['items']);
	};

	const expectCountMatchPlan = (baseGear: Gear, candidateIds: Array<number>) => {
		const candidates = candidateIds.map(realCandidateOf);
		const plan = planInventoryCombos(player, baseGear, candidates, (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
		expect(countInventoryCombos(player, baseGear, candidates)).toBe(plan.totalCombos);
		return plan;
	};

	it('agrees on an empty candidate list', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		expect(countInventoryCombos(player, realGearOf([[HEAD, 200]]), [])).toBe(0);
	});

	it('agrees on interchangeable-ring cross products', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[201] = { type: ItemType.ItemTypeHead };
		itemDefs[100] = { type: ItemType.ItemTypeFinger };
		itemDefs[101] = { type: ItemType.ItemTypeFinger };
		ownReal([100, 101]);
		const plan = expectCountMatchPlan(realGearOf([[HEAD, 201]]), [200]);
		expect(plan.totalCombos).toBe(6); // plain + {100} + {101} + {100,100} + {100,101} + {101,101}
	});

	it('agrees when unique and limit-category constraints exclude combos', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[100] = { type: ItemType.ItemTypeFinger, unique: true };
		itemDefs[101] = { type: ItemType.ItemTypeFinger, limitCategory: 7 };
		itemDefs[102] = { type: ItemType.ItemTypeFinger, limitCategory: 7 };
		itemDefs[103] = { type: ItemType.ItemTypeTrinket, unique: true };
		ownReal([100, 101, 102, 103]);
		const plan = expectCountMatchPlan(realGearOf([[T1, 103]]), [200]);
		expect(plan.totalCombos).toBeGreaterThan(1);
	});

	it('agrees when the candidate is already worn (non-unique ring gets the other finger only)', () => {
		itemDefs[100] = { type: ItemType.ItemTypeFinger };
		ownReal([100]);
		const plan = expectCountMatchPlan(realGearOf([[F1, 100]]), [100]);
		expect(plan.byCandidate[0].map(e => e.slot)).toEqual([F2]);
	});

	it('agrees when a two-hand candidate clears the offhand and OH combos become invalid', () => {
		itemDefs[300] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeOneHand };
		itemDefs[301] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeShield, handType: HandType.HandTypeOffHand };
		itemDefs[302] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeTwoHand };
		itemDefs[303] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeShield, handType: HandType.HandTypeOffHand };
		itemDefs[100] = { type: ItemType.ItemTypeFinger };
		ownReal([303, 100]);
		const plan = expectCountMatchPlan(
			realGearOf([
				[MH, 300],
				[OH, 301],
			]),
			[302],
		);
		// Equipping the 2H candidate clears the worn OH shield, so EVERY combo voids
		// the intact check (the untouched-OH comparison fails) — only the plain swap,
		// which skips that check, is countable. The OH slots stay empty there.
		expect(plan.byCandidate[0].map(e => [e.slot, e.swappedSlots])).toEqual([[MH, []]]);
		expect(plan.byCandidate[0][0].gear.getEquippedItem(OH)).toBeNull();
	});

	it('agrees when a two-hand candidate leaves the offhand free to combo', () => {
		// Same two-hander but nothing worn in OH to lose: the intact check survives
		// and finger/trinket combos count. This is the case the counter's id-level
		// weapon-clear simulation must NOT over-reject.
		itemDefs[300] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeOneHand };
		itemDefs[302] = { type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeTwoHand };
		itemDefs[100] = { type: ItemType.ItemTypeFinger };
		ownReal([100]);
		const plan = expectCountMatchPlan(realGearOf([[MH, 300]]), [302]);
		expect(plan.totalCombos).toBeGreaterThan(1);
		for (const entry of plan.byCandidate[0]) {
			expect(entry.gear.getEquippedItem(OH)).toBeNull();
		}
	});

	it('agrees under a swap that clears a worn unique copy in the other finger', () => {
		itemDefs[200] = { type: ItemType.ItemTypeHead };
		itemDefs[100] = { type: ItemType.ItemTypeFinger, unique: true };
		ownReal([100]);
		const plan = expectCountMatchPlan(realGearOf([[F1, 100]]), [200]);
		// F2 accepts the second copy, but equipping it clears the worn F1 copy, so no
		// combo with the ring may survive the intact check.
		for (const entry of plan.byCandidate[0]) {
			expect(entry.swappedSlots).toEqual([]);
		}
		expect(plan.totalCombos).toBe(1);
	});

	it('agrees when the per-candidate cap truncates the search', () => {
		itemDefs[500] = { type: ItemType.ItemTypeHead };
		const ids = Array.from({ length: 16 }, (_, i) => 100 + i);
		for (let i = 0; i < ids.length; i++) itemDefs[ids[i]] = { type: i < 8 ? ItemType.ItemTypeFinger : ItemType.ItemTypeTrinket };
		ownReal(ids);
		const plan = expectCountMatchPlan(realGearOf([]), [500]);
		expect(plan.totalCombos).toBe(INVENTORY_COMBO_MAX_COMBOS_PER_CANDIDATE);
		expect(plan.truncated).toBe(true);
	});

	it('agrees across randomized fixture draws', () => {
		// Deterministic PRNG (mulberry32): failure output reproduces exactly.
		const rand = (seed: number) => {
			let s = seed;
			return () => {
				s = (s + 0x6d2b79f5) | 0;
				let t = Math.imul(s ^ (s >>> 15), 1 | s);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		};
		const typeDraws: Array<{ type: ItemType; weaponType?: WeaponType; handType?: HandType }> = [
			{ type: ItemType.ItemTypeHead },
			{ type: ItemType.ItemTypeFinger },
			{ type: ItemType.ItemTypeTrinket },
			{ type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeOneHand },
			{ type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeSword, handType: HandType.HandTypeTwoHand },
			{ type: ItemType.ItemTypeWeapon, weaponType: WeaponType.WeaponTypeShield, handType: HandType.HandTypeOffHand },
		];
		const slotByType: Record<number, ItemSlot> = {
			[ItemType.ItemTypeHead]: HEAD,
			[ItemType.ItemTypeFinger]: F1,
			[ItemType.ItemTypeTrinket]: T1,
		};
		for (let seed = 1; seed <= 6; seed++) {
			const rng = rand(seed * 7919);
			itemDefs = {};
			const poolSize = 6 + Math.floor(rng() * 4);
			for (let i = 0; i < poolSize; i++) {
				const id = 1000 + seed * 100 + i;
				const draw = typeDraws[Math.floor(rng() * typeDraws.length)];
				itemDefs[id] = {
					...draw,
					unique: rng() < 0.2,
					limitCategory: rng() < 0.2 ? 1 + Math.floor(rng() * 3) : 0,
				};
			}
			const ids = Object.keys(itemDefs).map(Number);
			const worn: Array<[ItemSlot, number]> = [];
			const occupied = new Set<ItemSlot>();
			for (const id of ids) {
				if (rng() >= 0.5) continue;
				const def = itemDefs[id];
				const slot =
					def.type === ItemType.ItemTypeWeapon ? (def.handType === HandType.HandTypeTwoHand ? MH : rng() < 0.5 ? MH : OH) : slotByType[def.type];
				if (slot === undefined || occupied.has(slot)) continue;
				if (slot === OH && def.handType === HandType.HandTypeTwoHand) continue;
				occupied.add(slot);
				worn.push([slot, id]);
			}
			const inventoryIds = ids.filter(() => rng() < 0.7);
			const candidateIds = ids.filter(() => rng() < 0.5);
			ownReal(inventoryIds);
			const baseGear = realGearOf(worn);
			const candidates = candidateIds.map(realCandidateOf);
			const plan = planInventoryCombos(player, baseGear, candidates, (c, s) => baseGear.withEquippedItem(s, c.equippedItem), NO_FILL);
			expect(countInventoryCombos(player, baseGear, candidates)).toBe(plan.totalCombos);
		}
	});
});
