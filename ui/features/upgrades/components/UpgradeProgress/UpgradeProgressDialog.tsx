import { useSimHost } from '@sim/context/SimHostContext';
import type { ProgressTrackerHandle } from '@ui-kit/ProgressTrackerDialog';
import { ProgressTrackerDialog } from '@ui-kit/ProgressTrackerDialog';
import { useEffect, useRef } from 'react';

import { cancelUpgradeSim, subscribeUpgradeProgress } from '../../model/run';

/** Mounted only while a finder run is in flight; at rest there is nothing here. */
export const UpgradeProgressDialog = () => {
	const host = useSimHost();
	const barRef = useRef<ProgressTrackerHandle>(null);

	useEffect(
		() =>
			subscribeUpgradeProgress(host, progress => {
				barRef.current?.setProgress({ title: progress.title, current: progress.current, total: progress.total });
			}),
		[host],
	);

	return (
		<ProgressTrackerDialog
			open
			testId="upgrade-sim-progress-tracker"
			title="Upgrade Finder"
			state={{ stage: 'sim' }}
			hasProgressBar
			onCancel={() => void cancelUpgradeSim(host)}
			ref={barRef}
		/>
	);
};
