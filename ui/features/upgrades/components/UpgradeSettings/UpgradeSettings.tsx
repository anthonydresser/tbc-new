import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { usePlayerStore } from '@sim/hooks/usePlayerStore';
import { formatToNumber } from '@sim/utils/format';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Button } from '@ui-kit/Button';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';
import { useStore } from 'zustand';

import { useUpgradeState } from '../../hooks/useUpgradeState';
import { getUpgradeCandidateSimCount, setUpgradeOptimizeGems } from '../../model/items';
import { runUpgradeSim } from '../../model/run';
import { FallbackGemsPicker } from '../FallbackGemsPicker/FallbackGemsPicker';

/**
 * The finder's right column: how many sims the current candidates add up to, the run
 * button, the per-socket fallback gems, and the gem-optimizer toggle.
 */
export const UpgradeSettings = () => {
	const host = useSimHost();
	const player = host.player;
	const candidates = useUpgradeState(slice => slice.candidates);
	const optimizeGems = useUpgradeState(slice => slice.optimizeGems);
	const isRunning = useUpgradeState(slice => slice.isRunning);
	const iterations = useStore(player.sim.store, state => state.sim.iterations);
	// Eligible slots are per-item and per-spec, so gear changes also move the count.
	usePlayerStore('gear');

	const candidateSims = getUpgradeCandidateSimCount(player);
	const canRun = candidates.length > 0 && iterations > 0 && !isRunning;

	return (
		<TabPanelColumns.Right>
			<div className="sticky top-sim-header pt-6 lg:max-h-bulk-settings-max-h lg:overflow-y-auto">
				<div className="grid gap-6 border border-border bg-background p-4" data-testid="upgrade-settings-container">
					<div className="mb-0 text-fluid-xl leading-heading font-bold" data-testid="upgrade-sim-count">
						{candidateSims === 1
							? i18n.t('upgrade_tab.settings.sim_count_singular')
							: i18n.t('upgrade_tab.settings.sim_count', { count: candidateSims })}
						<br />
						<small className="text-base">
							{formatToNumber(iterations * Math.max(candidateSims, 0))} {i18n.t('upgrade_tab.settings.iterations')}
						</small>
					</div>
					<Button data-testid="upgrade-settings-btn" disabled={!canRun} onClick={() => void runUpgradeSim(host)}>
						{i18n.t('upgrade_tab.actions.simulate')}
					</Button>
					<FallbackGemsPicker />
					<div>
						<BooleanPicker
							modObject={player}
							config={{
								id: 'upgrade-optimize-gems',
								label: i18n.t('upgrade_tab.settings.optimize_gems.label'),
								labelTooltip: i18n.t('upgrade_tab.settings.optimize_gems.tooltip'),
								layout: 'inline',
								value: optimizeGems,
								onChange: (newValue: boolean) => setUpgradeOptimizeGems(player, newValue),
							}}
						/>
					</div>
				</div>
			</div>
		</TabPanelColumns.Right>
	);
};
