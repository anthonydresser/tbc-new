import { useSavedPanel } from '@features/hooks/useSavedPanel';
import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { serializeUpgradeRunState, upgradeRunsEqual } from '@sim/settings/upgrade_settings';
import type { SavedUpgradeRun } from '@sim/upgrade/types';
import { SavedDataPanel } from '@ui-kit/SavedDataPanel';
import { useCallback, useMemo } from 'react';

import { useSavedUpgradeRuns } from '../../hooks/useSavedUpgradeRuns';
import { useUpgradeState } from '../../hooks/useUpgradeState';
import { loadUpgradeRun } from '../../model/saved_runs';

/**
 * The finder's named-run list. Unlike every other saved-data panel, loading here is
 * destructive (it replaces candidates AND results), so the load callback in
 * model/saved_runs confirms over unsaved work; the active-chip match ignores name
 * and timestamp, which are bookkeeping added at save time.
 */
export const SavedUpgradeRuns = () => {
	const host = useSimHost();
	const player = host.player;
	const storage = useSavedUpgradeRuns();
	const settingsV = useUpgradeState(slice => slice.v.settings);
	const resultsV = useUpgradeState(slice => slice.v.results);
	// oxlint-disable-next-line react-hooks/exhaustive-deps — the version counters ARE the dependency.
	const current = useMemo(() => serializeUpgradeRunState(player), [player, settingsV, resultsV]);

	const hasMatchingSavedRun = useCallback(
		(currentRun: SavedUpgradeRun) => storage.entries.some(entry => upgradeRunsEqual(currentRun, entry.data)),
		[storage.entries],
	);

	// The saved copy takes the chip's name and the save click's timestamp, not the
	// empty name and snapshot time the live state carries.
	const save = useCallback((name: string, data: SavedUpgradeRun) => storage.save(name, { ...data, name, timestamp: Date.now() }), [storage]);

	const panel = useSavedPanel<SavedUpgradeRun>({
		label: i18n.t('upgrade_tab.saved_runs.run'),
		storage: { ...storage, save },
		current,
		serialize: ({ name: _name, timestamp: _timestamp, ...rest }) => JSON.stringify(rest),
		load: entry => void loadUpgradeRun(host, entry.data, entry.name, hasMatchingSavedRun),
	});

	return (
		<SavedDataPanel
			title={i18n.t('upgrade_tab.saved_runs.title')}
			nameLabel={i18n.t('upgrade_tab.saved_runs.name')}
			saveButtonText={i18n.t('upgrade_tab.saved_runs.save')}
			presets={[]}
			isActive={entry => upgradeRunsEqual(current, entry.data)}
			{...panel}
		/>
	);
};
