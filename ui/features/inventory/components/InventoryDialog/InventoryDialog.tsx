import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { useSimHost } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Dialog } from '@ui-kit/Dialog';
import { Icon } from '@ui-kit/Icon';
import { Tooltip } from '@ui-kit/Tooltip';
import { useId, useMemo } from 'react';

import { ItemDetailCell } from '@features/gear/components/ItemCell';
import { useOpenSelectorModal } from '@features/gear/hooks/useSelectorModal';
import { SelectorModalTabs } from '@features/gear/types';
import { getEligibleItemSlots } from '@sim/proto/items';
import type { EquippedItem } from '@sim/proto/equipped_item';

import { useInventoryState } from '../../hooks/useInventoryState';
import { addEquippedGearToInventory, clearInventory, removeInventoryItem } from '../../model/items';
import { createInventoryGearData } from '../../model/gear_data';

export interface InventoryDialogProps {
	open: boolean;
	onClose: () => void;
}

interface Row {
	slot: (ReturnType<typeof getEligibleItemSlots>)[number];
	slotLabel: string;
	item: EquippedItem;
	spec: ItemSpec;
}

/**
 * The inventory's management surface: every owned item with its stored enchant and
 * gems, grouped by slot. Edit reopens the shared selector modal pointed at the entry
 * through a GearData seam; remove/clear drop entries. Launched from the gear tab.
 */
export const InventoryDialog = ({ open, onClose }: InventoryDialogProps) => {
	const host = useSimHost();
	const player = host.player;
	const openSelectorModal = useOpenSelectorModal();
	const tooltipId = useId();

	const specs = useInventoryState(slice => slice?.items);

	const rows = useMemo(() => {
		const out: Row[] = [];
		for (const spec of specs ?? []) {
			const item = player.sim.db.lookupItemSpec(spec)?.withDynamicStats();
			if (!item) continue;
			const slot = getEligibleItemSlots(item.item)[0];
			out.push({ slot, slotLabel: translateSlotName(slot), item, spec });
		}
		return out.sort((a, b) => a.slotLabel.localeCompare(b.slotLabel) || a.item.item.name.localeCompare(b.item.item.name));
	}, [specs, player]);

	// A freshly edited entry stops resolving while the modal writes through; keeping
	// the row keyed by id (not index) means removals don't move the edit target.
	return (
		<Dialog open={open} onOpenChange={next => !next && onClose()} size="xl" scrollContents title={i18n.t('inventory.dialog.title')} testId="inventory-dialog">
			{rows.length === 0 ? (
				<p className="text-md" data-testid="inventory-empty">
					{i18n.t('inventory.dialog.empty')}
				</p>
			) : (
				<div className="flex w-full flex-col gap-1" data-testid="inventory-list">
					{rows.map(({ slot, slotLabel, item, spec }) => (
						<div
							key={spec.id}
							className="flex items-center gap-2 bg-gray-900 p-2"
							data-testid="inventory-row"
							data-slot-label={slotLabel}>
							<span className="w-28 shrink-0 text-sm text-gray-400">{slotLabel}</span>
							<div className="min-w-0 flex-1">
								<ItemDetailCell slot={slot} item={item} testId="inventory-item" />
							</div>
							<Button
								iconOnly
								aria-label={i18n.t('inventory.dialog.edit_tooltip')}
								data-testid="inventory-edit"
								data-tooltip-id={`${tooltipId}-edit`}
								onClick={() => openSelectorModal(slot, SelectorModalTabs.Items, createInventoryGearData(player, spec.id))}>
								<Icon name="pencil-alt" size="lg" />
							</Button>
							<Button
								iconOnly
								aria-label={i18n.t('inventory.dialog.remove_tooltip')}
								data-testid="inventory-remove"
								data-tooltip-id={`${tooltipId}-remove`}
								onClick={() => removeInventoryItem(player, spec.id)}>
								<Icon name="times" size="lg" />
							</Button>
						</div>
					))}
				</div>
			)}
			<div className="mt-4 flex w-full items-center gap-2">
				<Button variant="secondary" data-testid="inventory-add-equipped" onClick={() => addEquippedGearToInventory(player)}>
					<Icon name="download" className="mr-1" />
					{i18n.t('inventory.dialog.add_equipped_button')}
				</Button>
				<Button variant="danger" className="ml-auto" data-testid="inventory-clear" disabled={rows.length === 0} onClick={() => clearInventory(player)}>
					{i18n.t('inventory.dialog.clear_button')}
				</Button>
			</div>
			<Tooltip id={`${tooltipId}-edit`} content={i18n.t('inventory.dialog.edit_tooltip')} />
			<Tooltip id={`${tooltipId}-remove`} content={i18n.t('inventory.dialog.remove_tooltip')} />
		</Dialog>
	);
};
