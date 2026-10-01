import { usePlayer } from '@sim/context/SimHostContext';
import { upgradeRunFromJson } from '@sim/settings/upgrade_settings';
import { specStorageKey, UPGRADE_SAVED_RUNS_STORAGE_KEY } from '@sim/state/storage_keys';
import type { SavedUpgradeRun } from '@sim/upgrade/types';
import type { SavedDataCodec } from '@ui-kit/hooks/useSavedData';
import { useSavedData } from '@ui-kit/hooks/useSavedData';

// Round-trips through JSON so stored entries carry no undefined-valued keys
// (protobuf-ts fromJson rejects them on load).
const upgradeRunCodec: SavedDataCodec<SavedUpgradeRun> = {
	toJson: run => JSON.parse(JSON.stringify(run)),
	fromJson: upgradeRunFromJson,
};

// The finder's named runs share the pre-React slot's storage key, so lists saved
// before the React rewrite still show up.
export const useSavedUpgradeRuns = () => {
	const player = usePlayer();
	return useSavedData(specStorageKey(player.getPlayerSpec(), UPGRADE_SAVED_RUNS_STORAGE_KEY), upgradeRunCodec);
};
