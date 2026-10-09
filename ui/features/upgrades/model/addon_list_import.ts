// The reverse of addon_export.ts: a WWSULvN string produced in-game by the
// WoWSimsUpgradeList addon's Export popup (or saved from the sim's own Export
// to Addon dialog) repopulates the upgrade candidate list. The round trip is
// lossy on purpose — candidates only, no results — so the user re-runs the sim.
import type { ImporterDefinition } from '@features/import-export';
import i18n from '@i18n/config';
import type { Player } from '@sim/player/player';
import { patchUpgradeState, upgradeState } from '@sim/settings/upgrade_settings';
import { type AddonListParseResult, parseAddonUpgradeList } from '@sim/upgrade/addon_list_parser';
import type { UpgradeCandidate } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';

import { formatBisListErrors } from './bis';
import { isUpgradeRunningGuard, upgradeEligibleSlots } from './items';

// Replace semantics: the imported list becomes the whole candidate list (like a
// Clear followed by adds). Stale results are cleared in the same patch since
// they no longer belong to these candidates.
export const importAddonListCandidates = (player: Player<any>, parsed: AddonListParseResult): { added: number; skipped: number } | null => {
	if (isUpgradeRunningGuard(player)) return null;

	const db = player.sim.db;
	const candidates: UpgradeCandidate[] = [];
	let skipped = 0;
	for (const entry of parsed.candidates) {
		const equippedItem = db.lookupItemSpec(entry.spec)?.withDynamicStats();
		if (!equippedItem) {
			skipped++;
			continue;
		}
		const candidate: UpgradeCandidate = { spec: entry.spec, equippedItem, selectedEnchant: entry.enchant };
		if (!upgradeEligibleSlots(player, candidate).length) {
			skipped++;
			continue;
		}
		candidates.push(candidate);
	}

	const bumps: Array<'settings' | 'results'> = ['settings'];
	const patch: { candidates: UpgradeCandidate[]; results?: null } = { candidates };
	if (upgradeState(player).results) {
		patch.results = null;
		bumps.push('results');
	}
	patchUpgradeState(player, patch, bumps);
	return { added: candidates.length, skipped };
};

export const UPGRADE_LIST_IMPORTER: ImporterDefinition = {
	title: i18n.t('upgrade_tab.import_addon_list.title'),
	onImport: async (host, data) => {
		const result = await parseAddonUpgradeList(data);

		if (result.candidates.length === 0 && result.errors.length > 0) {
			throw new Error(formatBisListErrors(result.errors));
		}

		const applied = importAddonListCandidates(host.player, result);
		// Null means a run is in progress; the guard already explained that.
		if (!applied) return;
		const { added, skipped } = applied;

		toastManager.add({
			delay: 4000,
			variant: 'info',
			body: i18n.t('upgrade_tab.import_addon_list.results_not_restored', { name: result.listName, count: added }),
		});
		if (skipped > 0) {
			toastManager.add({
				variant: 'warning',
				body: i18n.t('upgrade_tab.import_addon_list.imported_with_skipped', { added, skipped }),
			});
		}
		// A list exported for another spec still imports — the eligibility guards
		// drop what doesn't fit — but the user should know.
		const currentSpec = host.player.getPlayerSpec().friendlyName.trim().toLowerCase();
		if (result.specName && result.specName.trim().toLowerCase() !== currentSpec) {
			toastManager.add({
				delay: 6000,
				variant: 'warning',
				body: i18n.t('upgrade_tab.import_addon_list.spec_mismatch', { spec: result.specName, currentSpec: host.player.getPlayerSpec().friendlyName }),
			});
		}
		if (result.errors.length > 0) {
			toastManager.add({
				variant: 'warning',
				delay: 8000,
				body: i18n.t('upgrade_tab.import_bis_list.imported_with_warnings', {
					count: added,
					errors: formatBisListErrors(result.errors),
				}),
			});
		}
	},
};
