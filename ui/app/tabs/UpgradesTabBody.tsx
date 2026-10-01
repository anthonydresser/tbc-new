import { Tabs } from '@base-ui/react/tabs';
import { SelectorModal } from '@features/gear/components/SelectorModal';
import { OpenSelectorModalContext, useSelectorModalState } from '@features/gear/hooks/useSelectorModal';
import { UpgradeCandidateList } from '@features/upgrades/components/UpgradeCandidateList/UpgradeCandidateList';
import { UpgradeItemSearch } from '@features/upgrades/components/UpgradeItemSearch/UpgradeItemSearch';
import { UpgradeProgressDialog } from '@features/upgrades/components/UpgradeProgress/UpgradeProgressDialog';
import { UpgradeResults } from '@features/upgrades/components/UpgradeResults/UpgradeResults';
import { UpgradeSettings } from '@features/upgrades/components/UpgradeSettings/UpgradeSettings';
import { useUpgradeState } from '@features/upgrades/hooks/useUpgradeState';
import { addUpgradeCandidate, clearUpgradeCandidates } from '@features/upgrades/model/items';
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { useSimReady } from '@sim/hooks/useSimReady';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import { TabNav, TabPanel, TabPanels } from '@ui-kit/TabNav';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';
import { LocaleHtml } from '@ui-kit/Tooltip';
import { useEffect, useState } from 'react';

const PANES = [
	{ id: 'upgradeSetupTab', labelKey: 'upgrade_tab.tabs.setup' },
	{ id: 'upgradeResultsTab', labelKey: 'upgrade_tab.tabs.results' },
] as const;

type UpgradePaneId = (typeof PANES)[number]['id'];

export const UpgradesTabBody = () => {
	const host = useSimHost();
	const ready = useSimReady();
	const results = useUpgradeState(slice => slice.results);
	const isRunning = useUpgradeState(slice => slice.isRunning);

	const [activeId, setActiveId] = useState<UpgradePaneId>('upgradeSetupTab');
	const selector = useSelectorModalState();
	// Starting a run clears the results and drops back to setup; finishing one opens the results.
	useEffect(() => setActiveId(results ? 'upgradeResultsTab' : 'upgradeSetupTab'), [results]);

	return (
		<OpenSelectorModalContext value={selector.openTab}>
			<TabPanelColumns.Left className="pt-2" variant="auto-columns">
				<Tabs.Root data-testid="upgrade-tab-tabs" value={activeId} onValueChange={next => setActiveId(next as UpgradePaneId)}>
					<TabNav tabs={PANES.map(pane => ({ id: pane.id, label: i18n.t(pane.labelKey) }))} />
					<TabPanels>
						<TabPanel value="upgradeSetupTab" className="gap-6 not-data-hidden:grid">
							<p className="mb-0">
								<LocaleHtml html={i18n.t('upgrade_tab.description')} />
							</p>
							<div className="flex grid-flow-col gap-3" data-testid="upgrade-gear-actions">
								<Button
									variant="secondary"
									onClick={() =>
										host.sim
											.getFilters()
											.favoriteItems.map(itemID => ItemSpec.create({ id: itemID }))
											.forEach(spec => addUpgradeCandidate(host.player, spec, true))
									}>
									<Icon name="download" style="base" className="mr-1" /> {i18n.t('upgrade_tab.actions.import_favorites')}
								</Button>
								<Button variant="danger" className="ml-auto" onClick={() => clearUpgradeCandidates(host.player)}>
									<Icon name="times" className="mr-1" />
									{i18n.t('upgrade_tab.actions.clear_items')}
								</Button>
							</div>
							<UpgradeItemSearch ready={ready} />
							<UpgradeCandidateList />
						</TabPanel>
						<TabPanel value="upgradeResultsTab">
							<UpgradeResults />
						</TabPanel>
					</TabPanels>
				</Tabs.Root>
			</TabPanelColumns.Left>
			<UpgradeSettings />
			<SelectorModal state={selector} id="upgrade-selector-modal" rail={false} />
			{isRunning && <UpgradeProgressDialog />}
		</OpenSelectorModalContext>
	);
};
