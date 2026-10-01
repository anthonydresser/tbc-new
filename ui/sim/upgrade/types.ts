// Shared shapes for the upgrade finder: one candidate is an item the finder may
// swap in place of an equipped item; one result is the best sim of a candidate in
// its winning slot. SavedUpgradeRun is the persisted form (localStorage +
// saved runs), and stays field-compatible with the pre-React upgrade tab's
// `upgrade-settings.v1` blob so existing data still loads.
import type { DistributionMetrics } from '@generated/proto/api';
import type { ItemSlot, ItemSpec } from '@generated/proto/common';
import type { UIEnchant as Enchant } from '@generated/proto/ui';

import type { EquippedItem } from '../proto/equipped_item';
import type { Gear } from '../proto/gear';

export interface UpgradeCandidate {
	spec: ItemSpec;
	equippedItem: EquippedItem;
	selectedEnchant: Enchant | null;
}

export interface UpgradeGearResult {
	gear: Gear;
	dpsMetrics: DistributionMetrics;
}

export interface UpgradeResult {
	item: EquippedItem;
	slot: ItemSlot;
	gear: Gear;
	dpsMetrics: DistributionMetrics;
	delta: number;
	// Delta of this candidate when swapped into the BiS reference set instead of the
	// current gear (0 for the item the reference set already wears). Undefined when
	// the run had no BiS reference.
	bisDelta?: number;
}

// The JSON blob: item/gear entries are protobuf-JSON objects (any), so they round
// trip through ItemSpec.fromJson / EquipmentSpec.fromJson on load. Numeric metrics
// fields keep their protobuf-JSON names.
export interface SavedUpgradeRun {
	name: string;
	timestamp: number;
	items: Array<Record<string, unknown>>;
	fallbackGems: Array<number>;
	optimizeGems: boolean;
	compareBisEnabled: boolean;
	bisReferenceName: string;
	bisReferenceIsPreset: boolean;
	baselineResult: Record<string, unknown> | null;
	bisResult: Record<string, unknown> | null;
	upgradeResults: Array<Record<string, unknown>>;
}
