import { ItemDetailCell } from '@features/gear/components/ItemCell';
import { SelectorModal } from '@features/gear/components/SelectorModal';
import { OpenSelectorModalContext, useSelectorModalState } from '@features/gear/hooks/useSelectorModal';
import { SelectorModalTabs } from '@features/gear/types';
import { InventoryItemSearch } from '@features/inventory/components/InventoryItemSearch/InventoryItemSearch';
import { useInventoryState } from '@features/inventory/hooks/useInventoryState';
import { createInventoryGearData } from '@features/inventory/model/gear_data';
import { addEquippedGearToInventory, clearInventory, removeInventoryItem } from '@features/inventory/model/items';
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { useSimHost } from '@sim/context/SimHostContext';
import { useSimReady } from '@sim/hooks/useSimReady';
import type { EquippedItem } from '@sim/proto/equipped_item';
import { getEligibleItemSlots } from '@sim/proto/items';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';
import { Tooltip } from '@ui-kit/Tooltip';
import { useId, useMemo } from 'react';

interface Row {
	slot: (ReturnType<typeof getEligibleItemSlots>)[number];
	slotLabel: string;
	item: EquippedItem;
	spec: ItemSpec;
}

/**
 * The inventory's management surface: every owned item with its stored enchant and
 * gems, grouped by slot. Items are added from the search (or the box toggle in any
 * item picker); Edit reopens the shared selector modal pointed at the entry through
 * a GearData seam; remove/clear drop entries.
 */
export const InventoryTabBody = () => {
	const host = useSimHost();
	const player = host.player;
	const ready = useSimReady();
	// The tab owns its selector modal, so edit buttons use it directly rather than the
	// context (which this component provides for deeper children, like ItemDetailCell's).
	const selector = useSelectorModalState();
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
		<OpenSelectorModalContext value={selector.openTab}>
			<TabPanelColumns.Left variant="auto-columns" className="pt-2">
				<InventoryItemSearch ready={ready} />
				{rows.length === 0 ? (
					<p className="text-md" data-testid="inventory-empty">
						{i18n.t('inventory.tab.empty')}
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
									aria-label={i18n.t('inventory.tab.edit_tooltip')}
									data-testid="inventory-edit"
									data-tooltip-id={`${tooltipId}-edit`}
									onClick={() => selector.openTab(slot, SelectorModalTabs.Items, createInventoryGearData(player, spec.id))}>
									<Icon name="pencil-alt" size="lg" />
								</Button>
								<Button
									iconOnly
									aria-label={i18n.t('inventory.tab.remove_tooltip')}
									data-testid="inventory-remove"
									data-tooltip-id={`${tooltipId}-remove`}
									onClick={() => removeInventoryItem(player, spec.id)}>
									<Icon name="times" size="lg" />
								</Button>
							</div>
						))}
					</div>
				)}
				<div className="flex w-full items-center gap-2">
					<Button variant="secondary" data-testid="inventory-add-equipped" onClick={() => addEquippedGearToInventory(player)}>
						<Icon name="download" className="mr-1" />
						{i18n.t('inventory.tab.add_equipped_button')}
					</Button>
					<Button variant="danger" className="ml-auto" data-testid="inventory-clear" disabled={rows.length === 0} onClick={() => clearInventory(player)}>
						{i18n.t('inventory.tab.clear_button')}
					</Button>
				</div>
			</TabPanelColumns.Left>
			<Tooltip id={`${tooltipId}-edit`} content={i18n.t('inventory.tab.edit_tooltip')} />
			<Tooltip id={`${tooltipId}-remove`} content={i18n.t('inventory.tab.remove_tooltip')} />
			<SelectorModal state={selector} id="inventory-selector-modal" rail={false} />
		</OpenSelectorModalContext>
	);
};
