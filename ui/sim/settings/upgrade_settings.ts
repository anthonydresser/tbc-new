// The upgrade finder's store slice and its persisted run-state blob. Everything is
// derived from the player: the slice is `upgrades[player.storeKey]` and the storage
// key is the player's spec prefix + `upgrade-settings.v1` (the same key the
// pre-React upgrade tab used, so existing state still loads).
//
// The blob is deliberately never deleted on a quota error and never clobbered when
// it can't be parsed — a previously stored run is better than no run; corrupt blobs
// are copied aside to `.corrupt-backup` first.
import { DistributionMetrics } from '@generated/proto/api';
import { EquipmentSpec, GemColor, ItemSlot, ItemSpec } from '@generated/proto/common';
import type { UIEnchant } from '@generated/proto/ui';

import type { Player } from '../player/player';
import { Database } from '../proto/database';
import { getEligibleItemSlots } from '../proto/items';
import { patchKeyed, seedKeyed, type UpgradeSlice } from '../state/sim_store';
import { specStorageKey } from '../state/storage_keys';
import type { SavedUpgradeRun, UpgradeGearResult, UpgradeResult } from '../upgrade/types';

export const UPGRADE_SETTINGS_STORAGE_KEY = 'upgrade-settings.v1';
const CORRUPT_BACKUP_SUFFIX = '.corrupt-backup';

// One fallback gem id per socket color, in this order.
export const FALLBACK_GEM_COLORS = [
	GemColor.GemColorRed,
	GemColor.GemColorYellow,
	GemColor.GemColorBlue,
	GemColor.GemColorMeta,
	GemColor.GemColorPrismatic,
] as const;

const initialUpgradeSlice = (): UpgradeSlice => ({
	candidates: [],
	fallbackGemIds: Array.from({ length: FALLBACK_GEM_COLORS.length }, () => 0),
	optimizeGems: false,
	isRunning: false,
	runGear: null,
	baseline: null,
	results: null,
	v: { settings: 0, results: 0 },
});

// Seeds the slice before any subscriber exists (emit-less).
export const seedUpgradeSettings = (player: Player<any>) => seedKeyed(player.sim.store, 'upgrades', player.storeKey, initialUpgradeSlice());

export const upgradeState = (player: Player<any>): UpgradeSlice => player.sim.store.getState().upgrades[player.storeKey];

// A bump with an empty patch is a bare emit; a patch with no bumps is a silent field write.
export const patchUpgradeState = (player: Player<any>, patch: Partial<Omit<UpgradeSlice, 'v'>>, bumps: ReadonlyArray<keyof UpgradeSlice['v']> = []) =>
	patchKeyed(player.sim.store, 'upgrades', player.storeKey, patch, bumps);

// ---------------------------------------------------------------------------
// Saved-run serialization

// hist and allValues can each contain thousands of entries and are never displayed,
// so drop them from persisted data to stay well under the localStorage quota.
const metricsToJson = (metrics: DistributionMetrics): Record<string, unknown> => {
	const json = DistributionMetrics.toJson(metrics) as Record<string, unknown>;
	delete json.hist;
	delete json.allValues;
	return json;
};

// Strips keys whose value is undefined before feeding stored JSON to protobuf-ts
// fromJson. Runs serialized by older builds (or copied in-memory without a
// JSON.stringify round trip) can carry keys like "enchant": undefined, which
// fromJson rejects.
const sanitizeProtoJson = (json: any): any => {
	if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
	const clean = Object.fromEntries(Object.entries(json as Record<string, any>).filter(([, value]) => value !== undefined));
	if (Array.isArray(clean.items)) clean.items = clean.items.map((item: any) => sanitizeProtoJson(item));
	return clean;
};

const gearResultToJson = (result: UpgradeGearResult | null): Record<string, unknown> | null =>
	result ? { gear: EquipmentSpec.toJson(result.gear.asSpec()) as Record<string, unknown>, dpsMetrics: metricsToJson(result.dpsMetrics) } : null;

export const serializeUpgradeRunState = (player: Player<any>, name = ''): SavedUpgradeRun => {
	const state = upgradeState(player);
	return {
		name,
		timestamp: Date.now(),
		items: state.candidates.map(candidate => {
			const base = ItemSpec.toJson(candidate.spec) as Record<string, any>;
			// Never assign undefined here: a present-but-undefined "enchant" key survives
			// plain-object copies and then crashes ItemSpec.fromJson with "Cannot parse
			// JSON undefined", silently dropping every unenchanted candidate.
			if (candidate.selectedEnchant) base.enchant = candidate.selectedEnchant.effectId;
			return base;
		}),
		fallbackGems: state.fallbackGemIds.slice(),
		optimizeGems: state.optimizeGems,
		compareBisEnabled: false,
		bisReferenceName: '',
		bisReferenceIsPreset: false,
		baselineResult: gearResultToJson(state.baseline),
		bisResult: null,
		upgradeResults: (state.results ?? []).map(result => ({
			item: ItemSpec.toJson(result.item.asSpec()) as Record<string, unknown>,
			slot: result.slot,
			gear: EquipmentSpec.toJson(result.gear.asSpec()) as Record<string, unknown>,
			dpsMetrics: metricsToJson(result.dpsMetrics),
			delta: result.delta,
			bisDelta: result.bisDelta,
		})),
	};
};

// Writes the run state. Returns false on a quota error, keeping the previously
// stored state in place — the caller surfaces the toast.
export const storeUpgradeRunState = (player: Player<any>): boolean => {
	const { storage } = player.sim.env;
	const key = specStorageKey(player.getPlayerSpec(), UPGRADE_SETTINGS_STORAGE_KEY);
	try {
		storage.setItem(key, JSON.stringify(serializeUpgradeRunState(player)));
		return true;
	} catch (e) {
		console.error('Failed to persist upgrade finder state:', e);
		return false;
	}
};

// Runs may reference items that only exist in the leftover item DB (anything
// imported via Import BiS List / presets resolves through it), which is merged
// into the shared database only on demand. Without this, restoring such a run in
// a fresh session would drop every leftover item from the saved state.
const gatherRunEquipment = (run: SavedUpgradeRun): EquipmentSpec => {
	const items: ItemSpec[] = [];
	const pushItem = (itemJson: any) => {
		try {
			const spec = ItemSpec.fromJson(sanitizeProtoJson(itemJson));
			if (spec.id) items.push(spec);
		} catch {
			// Malformed entries are reported as dropped by applyUpgradeRunState instead.
		}
	};
	const pushEquipment = (gearJson: any) => {
		try {
			EquipmentSpec.fromJson(gearJson).items.forEach(item => {
				if (item.id) items.push(item);
			});
		} catch {
			// Malformed entries are reported as dropped by applyUpgradeRunState instead.
		}
	};

	(run.items || []).forEach(pushItem);
	pushEquipment(run.baselineResult?.gear);
	pushEquipment(run.bisResult?.gear);
	(run.upgradeResults || []).forEach(resultJson => {
		pushItem(resultJson?.item);
		pushEquipment(resultJson?.gear);
	});
	return EquipmentSpec.create({ items });
};

// Matches an effect/item/spell id against the enchants of every slot an item fits,
// the way the pre-React tab resolved a stored enchant id back to an enchant.
const findEnchantForItem = (db: Database, itemId: number, effectId: number): UIEnchant | null => {
	const item = db.lookupItemSpec(ItemSpec.create({ id: itemId }))?.item;
	if (!item) return null;
	for (const slot of getEligibleItemSlots(item)) {
		const enchant = db.getEnchants(slot).find(e => e.effectId === effectId || e.itemId === effectId || e.spellId === effectId);
		if (enchant) return enchant;
	}
	return null;
};

const parseStoredGearResult = (player: Player<any>, resultJson: any): UpgradeGearResult | null => {
	if (!resultJson) return null;
	try {
		const gear = player.sim.db.lookupEquipmentSpec(EquipmentSpec.fromJson(resultJson.gear));
		const dpsMetrics = DistributionMetrics.fromJson(resultJson.dpsMetrics);
		return { gear, dpsMetrics };
	} catch {
		return null;
	}
};

// Applies a stored run to the slice. Items and results that fail to resolve against
// the database are dropped, not fatal, and the counts come back for the toast.
export const applyUpgradeRunState = async (player: Player<any>, run: SavedUpgradeRun): Promise<{ droppedItems: number; droppedResults: number }> => {
	const { db } = player.sim;
	const runEquipment = gatherRunEquipment(run);
	if (runEquipment.items.length) {
		try {
			await Database.loadLeftoversIfNecessary(runEquipment);
		} catch (error) {
			console.error('Failed to load leftover item database for saved upgrade run:', error);
		}
	}

	let droppedItems = 0;
	const candidates: UpgradeSlice['candidates'] = [];
	(run.items || []).forEach(itemJson => {
		try {
			const itemSpec = ItemSpec.fromJson(sanitizeProtoJson(itemJson));
			const equippedItem = db.lookupItemSpec(itemSpec)?.withDynamicStats();
			if (!equippedItem) {
				console.warn('Saved upgrade run: item not found in database:', itemJson);
				droppedItems++;
				return;
			}
			const enchant = typeof (itemJson as any).enchant === 'number' ? findEnchantForItem(db, itemSpec.id, (itemJson as any).enchant) : null;
			candidates.push({ spec: itemSpec, equippedItem, selectedEnchant: enchant ?? null });
		} catch (error) {
			console.warn('Saved upgrade run: failed to restore item:', itemJson, error);
			droppedItems++;
		}
	});

	const fallbackGemIds = Array.from({ length: FALLBACK_GEM_COLORS.length }, (_, idx) => run.fallbackGems?.[idx] ?? 0);

	const baseline = parseStoredGearResult(player, run.baselineResult);

	let droppedResults = 0;
	const results: UpgradeResult[] = [];
	(run.upgradeResults || []).forEach(resultJson => {
		try {
			const itemSpec = ItemSpec.fromJson(sanitizeProtoJson(resultJson?.item));
			const item = db.lookupItemSpec(itemSpec)?.withDynamicStats();
			if (!item) {
				console.warn('Saved upgrade run: result item not found in database:', resultJson?.item);
				droppedResults++;
				return;
			}
			const gear = player.sim.db.lookupEquipmentSpec(EquipmentSpec.fromJson(resultJson.gear as any));
			const dpsMetrics = DistributionMetrics.fromJson(resultJson.dpsMetrics as any);
			results.push({
				item,
				slot: resultJson.slot as ItemSlot,
				gear,
				dpsMetrics,
				// Fall back to the stored delta if the baseline result didn't survive the round trip,
				// rather than reporting the raw average as if it were a gain.
				delta: baseline ? dpsMetrics.avg - baseline.dpsMetrics.avg : ((resultJson.delta as number | undefined) ?? 0),
				// Runs saved before the per-candidate reference sim have no stored bisDelta.
				bisDelta: typeof resultJson.bisDelta === 'number' ? resultJson.bisDelta : undefined,
			});
		} catch (error) {
			console.warn('Saved upgrade run: failed to restore result:', resultJson?.item, error);
			droppedResults++;
		}
	});

	patchUpgradeState(
		player,
		{
			candidates,
			fallbackGemIds,
			optimizeGems: run.optimizeGems ?? false,
			baseline,
			results,
		},
		results.length ? ['settings', 'results'] : ['settings'],
	);
	return { droppedItems, droppedResults };
};

// Reads the persisted blob. Returns null when nothing is stored; a corrupt blob is
// moved to `.corrupt-backup` and then treated as absent.
export const loadStoredUpgradeRunState = (player: Player<any>): SavedUpgradeRun | null => {
	const { storage } = player.sim.env;
	const key = specStorageKey(player.getPlayerSpec(), UPGRADE_SETTINGS_STORAGE_KEY);
	const stored = storage.getItem(key);
	if (stored == null) return null;

	try {
		const parsed = JSON.parse(stored);
		if (!parsed || !Array.isArray(parsed.items)) return null;
		return {
			name: parsed.name ?? '',
			timestamp: parsed.timestamp ?? 0,
			items: parsed.items,
			fallbackGems: parsed.fallbackGems ?? [],
			optimizeGems: parsed.optimizeGems ?? false,
			compareBisEnabled: parsed.compareBisEnabled ?? false,
			bisReferenceName: parsed.bisReferenceName ?? '',
			bisReferenceIsPreset: parsed.bisReferenceIsPreset ?? false,
			baselineResult: parsed.baselineResult ?? null,
			bisResult: parsed.bisResult ?? null,
			upgradeResults: parsed.upgradeResults ?? [],
		};
	} catch (e) {
		console.error('Failed to parse saved upgrade finder state:', e);
		try {
			storage.setItem(`${key}${CORRUPT_BACKUP_SUFFIX}`, stored);
		} catch (backupError) {
			console.error('Failed to back up corrupt upgrade finder state:', backupError);
		}
		return null;
	}
};
