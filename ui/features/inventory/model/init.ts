import i18n from '@i18n/config';
import { applyStoredInventory, loadStoredInventory, seedInventorySettings, storeInventory } from '@sim/settings/inventory_settings';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeInventoryChange } from '@sim/state/subscriptions';
import { toastManager } from '@ui-kit/Toast';

/**
 * The inventory belongs to the page, not to any one tab: the selector modal,
 * upgrades, and bulk all read it whether or not the gear tab is open, so the
 * host calls this once rather than waiting for a component to mount.
 */
export const initInventory = (host: IndividualSimHost<any>) => {
	const { sim, player } = host;
	seedInventorySettings(player);

	// The quota toast fires once per page; a failed write keeps the old blob, so
	// reporting every subsequent failure adds nothing.
	let storageWarningShown = false;

	sim.waitForInit().then(async () => {
		const stored = loadStoredInventory(player);
		if (stored) {
			const { dropped } = await applyStoredInventory(player, stored);
			if (dropped > 0) {
				toastManager.add({
					variant: 'warning',
					body: i18n.t('inventory.notifications.items_not_restored', { count: dropped }),
				});
			}
		}

		subscribeInventoryChange(player)(() => {
			if (!storeInventory(player) && !storageWarningShown) {
				storageWarningShown = true;
				toastManager.add({ variant: 'error', body: i18n.t('inventory.notifications.storage_full') });
			}
		});
	});
};
