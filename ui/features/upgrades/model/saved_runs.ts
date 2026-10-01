// Loading a named saved run is the one destructive action the saved-data panel
// offers, so the guards live here: a run mid-simulation is untouched, and loading
// over unsaved work asks first.
import i18n from '@i18n/config';
import { applyUpgradeRunState, serializeUpgradeRunState, storeUpgradeRunState, upgradeRunsEqual, upgradeState } from '@sim/settings/upgrade_settings';
import type { IndividualSimHost } from '@sim/sim_host';
import type { SavedUpgradeRun } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';

import { isUpgradeRunningGuard } from './items';

/**
 * Applies a saved run to the slice. `hasMatchingSavedRun` answers whether the live
 * state still equals some other saved run — the unsaved-changes confirmation is
 * skipped when it does, or when the state is empty, since nothing is lost either way.
 */
export const loadUpgradeRun = async (
	host: IndividualSimHost<any>,
	run: SavedUpgradeRun,
	name: string,
	hasMatchingSavedRun: (current: SavedUpgradeRun) => boolean,
) => {
	const { player } = host;
	if (isUpgradeRunningGuard(player)) return;

	const runName = name || run.name;
	const { candidates, results } = upgradeState(player);
	if (candidates.length > 0 || (results?.length ?? 0) > 0) {
		const current = serializeUpgradeRunState(player);
		if (!upgradeRunsEqual(current, run) && !hasMatchingSavedRun(current)) {
			if (!confirm(i18n.t('upgrade_tab.saved_runs.unsaved_changes_confirm', { name: runName }))) return;
		}
	}

	const { droppedItems, droppedResults } = await applyUpgradeRunState(player, run);
	// Persist immediately: a reloaded page should come back to the just-loaded run.
	storeUpgradeRunState(player);

	if (droppedItems + droppedResults > 0) {
		toastManager.add({
			delay: 5000,
			variant: 'warning',
			body: i18n.t('upgrade_tab.saved_runs.items_not_restored', { count: droppedItems + droppedResults }),
		});
	} else {
		toastManager.add({
			delay: 2000,
			variant: 'success',
			body: i18n.t('upgrade_tab.saved_runs.loaded', { name: runName }),
		});
	}
};
