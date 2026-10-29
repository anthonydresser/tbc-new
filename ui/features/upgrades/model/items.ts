import { GemColor, type ItemSlot, ItemSpec } from '@generated/proto/common';
import type { UIGem as Gem } from '@generated/proto/ui';
import i18n from '@i18n/config';
import type { Player } from '@sim/player/player';
import { canEquipItem, getEligibleItemSlots } from '@sim/proto/items';
import { inventoryItems } from '@sim/settings/inventory_settings';
import { FALLBACK_GEM_COLORS, findEnchantForItem, patchUpgradeState, upgradeState } from '@sim/settings/upgrade_settings';
import type { UpgradeCandidate, UpgradeResult } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';

// The sim loop iterates the candidate list live, so mutating it mid-run would
// silently drop items from the results.
export const isUpgradeRunningGuard = (player: Player<any>, silent = false): boolean => {
	if (!upgradeState(player).isRunning) return false;
	if (!silent) {
		toastManager.add({ variant: 'warning', body: i18n.t('upgrade_tab.notifications.busy_while_running') });
	}
	return true;
};

export const upgradeEligibleSlots = (player: Player<any>, candidate: UpgradeCandidate): ItemSlot[] =>
	getEligibleItemSlots(candidate.equippedItem.item).filter(slot => canEquipItem(candidate.equippedItem.item, player.getPlayerSpec(), slot));

export const addUpgradeCandidate = (player: Player<any>, itemSpec: ItemSpec, silent = false) => {
	if (isUpgradeRunningGuard(player, silent)) return false;
	const { candidates } = upgradeState(player);

	if (candidates.some(candidate => ItemSpec.equals(candidate.spec, itemSpec))) {
		if (!silent) toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.notifications.item_duplicate') });
		return false;
	}

	const equippedItem = player.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
	if (!equippedItem) {
		if (!silent) toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.notifications.item_not_found') });
		return false;
	}

	if (!upgradeEligibleSlots(player, { spec: itemSpec, equippedItem, selectedEnchant: null }).length) {
		if (!silent) toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.notifications.item_not_equippable') });
		return false;
	}

	patchUpgradeState(player, { candidates: [...candidates, { spec: ItemSpec.clone(itemSpec), equippedItem, selectedEnchant: null }] }, ['settings']);

	if (!silent) {
		toastManager.add({ variant: 'success', body: i18n.t('upgrade_tab.search.item_added', { itemName: equippedItem.item.name }) });
	}
	return true;
};

export const removeUpgradeCandidate = (player: Player<any>, index: number) => {
	if (isUpgradeRunningGuard(player)) return;
	const { candidates } = upgradeState(player);
	if (index < 0 || index >= candidates.length) return;
	const removed = candidates[index];
	patchUpgradeState(player, { candidates: candidates.filter((_, idx) => idx !== index) }, ['settings']);
	toastManager.add({ variant: 'success', body: i18n.t('upgrade_tab.search.item_removed', { itemName: removed.equippedItem.item.name }) });
};

export const clearUpgradeCandidates = (player: Player<any>) => {
	if (isUpgradeRunningGuard(player)) return;
	patchUpgradeState(player, { candidates: [] }, ['settings']);
};

export const setUpgradeFallbackGem = (player: Player<any>, socketIndex: number, gemId: number) => {
	const fallbackGemIds = upgradeState(player).fallbackGemIds.slice();
	fallbackGemIds[socketIndex] = gemId;
	patchUpgradeState(player, { fallbackGemIds }, ['settings']);
};

export const setUpgradeOptimizeGems = (player: Player<any>, optimizeGems: boolean) => patchUpgradeState(player, { optimizeGems }, ['settings']);

export const setUpgradeHideOwnedResults = (player: Player<any>, hideOwnedResults: boolean) =>
	patchUpgradeState(player, { hideOwnedResults }, ['settings']);

/**
 * Imports the inventory as candidates, preserving each entry's authored setup: the
 * stored gems ride along on the ItemSpec itself, and the stored enchant id resolves
 * to a UIEnchant the same way a saved run restores it. Unlike `import from
 * favorites` — which feeds bare item ids through `addUpgradeCandidate` — entries
 * here already carry their setup, so duplicate detection is full-spec equality.
 */
export const importInventoryAsCandidates = (player: Player<any>) => {
	if (isUpgradeRunningGuard(player)) return;
	const { db } = player.sim;
	const imported: UpgradeCandidate[] = [];
	let skipped = 0;

	for (const spec of inventoryItems(player)) {
		if (upgradeState(player).candidates.concat(imported).some(candidate => ItemSpec.equals(candidate.spec, spec))) {
			skipped++;
			continue;
		}
		const equippedItem = db.lookupItemSpec(spec)?.withDynamicStats();
		if (!equippedItem || !upgradeEligibleSlots(player, { spec, equippedItem, selectedEnchant: null }).length) {
			skipped++;
			continue;
		}
		const selectedEnchant = spec.enchant ? findEnchantForItem(db, spec.id, spec.enchant) : null;
		imported.push({ spec: ItemSpec.clone(spec), equippedItem, selectedEnchant });
	}

	if (imported.length) {
		patchUpgradeState(player, { candidates: [...upgradeState(player).candidates, ...imported] }, ['settings']);
	}
	toastManager.add({
		variant: skipped ? 'warning' : 'success',
		body: skipped
			? i18n.t('upgrade_tab.import_inventory.imported_with_skipped', { added: imported.length, skipped })
			: i18n.t('upgrade_tab.import_inventory.imported', { added: imported.length }),
	});
};

export const setCandidateEnchant = (player: Player<any>, index: number, enchant: UpgradeCandidate['selectedEnchant']) => {
	if (isUpgradeRunningGuard(player)) return;
	const { candidates } = upgradeState(player);
	const candidate = candidates[index];
	if (!candidate) return;
	patchUpgradeState(
		player,
		{
			candidates: candidates.map((c, idx) => (idx === index ? { ...c, selectedEnchant: enchant } : c)),
		},
		['settings'],
	);
};

export const getUpgradeCandidateSimCount = (player: Player<any>): number =>
	upgradeState(player).candidates.reduce((sum, candidate) => sum + upgradeEligibleSlots(player, candidate).length, 0);

// A reference is in effect only when both the toggle and a set name are present; the
// run loop resolves the name and warns instead of failing when the set is gone.
export const hasBisReferenceSim = (player: Player<any>): boolean => {
	const { compareBisEnabled, bisReferenceName } = upgradeState(player);
	return compareBisEnabled && !!bisReferenceName;
};

// Baseline + one sim per candidate per eligible slot. A BiS reference doubles each
// of those (every candidate is also simmed on the reference set) and adds one more
// for the reference set itself.
export const getUpgradeTotalSimCount = (player: Player<any>): number =>
	1 + getUpgradeCandidateSimCount(player) * (hasBisReferenceSim(player) ? 2 : 1) + (hasBisReferenceSim(player) ? 1 : 0);

// Some candidates can appear in the results more than once (e.g. imported with
// different enchants). Only the single best instance of each item is shown/exported.
export const getDisplayedUpgradeResults = (results: Array<UpgradeResult>): Array<UpgradeResult> => {
	const bestResultByItemId = new Map<number, UpgradeResult>();
	for (const result of results) {
		const existing = bestResultByItemId.get(result.item.item.id);
		if (!existing || result.delta > existing.delta) bestResultByItemId.set(result.item.item.id, result);
	}
	return Array.from(bestResultByItemId.values()).sort((a, b) => b.delta - a.delta);
};

// The hide-owned filter, applied after getDisplayedUpgradeResults: ownership is
// id-level, so every entry of an owned item disappears regardless of setup.
export const getVisibleUpgradeResults = (results: Array<UpgradeResult>, ownedIds: Set<number>, hideOwned: boolean): Array<UpgradeResult> =>
	hideOwned ? results.filter(result => !ownedIds.has(result.item.item.id)) : results;

export const getDefaultGemsByColor = (player: Player<any>): Map<GemColor, Gem | null> => {
	const gemsByColor = new Map<GemColor, Gem | null>();
	FALLBACK_GEM_COLORS.forEach((color, idx) => {
		const gemId = upgradeState(player).fallbackGemIds[idx];
		gemsByColor.set(color, gemId ? player.sim.db.lookupGem(gemId) : null);
	});
	return gemsByColor;
};
