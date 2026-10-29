import { GearPicker } from '@features/gear/components/GearPicker';
import { SelectorModal } from '@features/gear/components/SelectorModal';
import { GemSummary } from '@features/gear/components/SummaryTable';
import { OpenSelectorModalContext, useSelectorModalState } from '@features/gear/hooks/useSelectorModal';
import { InventoryDialog } from '@features/inventory/components/InventoryDialog/InventoryDialog';
import i18n from '@i18n/config';
import { useSimReady } from '@sim/hooks/useSimReady';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';
import { useState } from 'react';

import { GearPresets } from '../GearPresets';

export const GearTabBody = () => {
	const ready = useSimReady();
	const selector = useSelectorModalState();
	const [inventoryOpen, setInventoryOpen] = useState(false);

	return (
		<OpenSelectorModalContext value={selector.openTab}>
			<TabPanelColumns.Left variant="auto-columns">
				{/* Inside the OpenSelectorModalContext so the dialog's Edit buttons reuse this tab's modal. */}
				<div className="flex justify-end">
					<Button variant="secondary" data-testid="open-inventory-dialog" onClick={() => setInventoryOpen(true)}>
						<Icon name="box" className="mr-1" />
						{i18n.t('inventory.title')}
					</Button>
				</div>
				<GearPicker ready={ready} />
				<div className="grid grid-flow-row grid-cols-2 gap-section max-md:grid-cols-1">
					<GemSummary />
				</div>
			</TabPanelColumns.Left>
			<TabPanelColumns.Right>
				<GearPresets />
			</TabPanelColumns.Right>
			<InventoryDialog open={inventoryOpen} onClose={() => setInventoryOpen(false)} />
			<SelectorModal state={selector} />
		</OpenSelectorModalContext>
	);
};
