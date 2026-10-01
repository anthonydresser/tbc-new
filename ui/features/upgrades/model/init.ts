import i18n from '@i18n/config';
import { applyUpgradeRunState, loadStoredUpgradeRunState, seedUpgradeSettings, storeUpgradeRunState } from '@sim/settings/upgrade_settings';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeUpgradeChange } from '@sim/state/subscriptions';
import { toastManager } from '@ui-kit/Toast';

/**
 * The finder belongs to the page, not to its tab: the saved state has to be restored
 * and kept persisted whether or not the tab is open, so none of this can wait for
 * `UpgradesTabBody` to mount. The host calls it once.
 */
export const initUpgrades = (host: IndividualSimHost<any>) => {
	const { sim, player } = host;
	seedUpgradeSettings(player);

	// The quota toast fires once per page; a failed write keeps the old blob, so
	// reporting every subsequent failure adds nothing.
	let storageWarningShown = false;

	sim.waitForInit().then(async () => {
		const stored = loadStoredUpgradeRunState(player);
		if (stored) {
			const { droppedItems, droppedResults } = await applyUpgradeRunState(player, stored);
			if (droppedItems + droppedResults > 0) {
				toastManager.add({
					variant: 'warning',
					body: i18n.t('upgrade_tab.saved_runs.items_not_restored', { count: droppedItems + droppedResults }),
				});
			}
		}

		subscribeUpgradeChange(player)(() => {
			if (!storeUpgradeRunState(player) && !storageWarningShown) {
				storageWarningShown = true;
				toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.saved_runs.storage_full') });
			}
		});
	});
};
