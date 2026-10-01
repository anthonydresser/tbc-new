import { usePlayer } from '@sim/context/SimHostContext';
import type { UpgradeSlice } from '@sim/state/sim_store';
import { useStore } from 'zustand';

export const useUpgradeState = <T>(selector: (slice: UpgradeSlice) => T): T => {
	const player = usePlayer();
	return useStore(player.sim.store, state => selector(state.upgrades[player.storeKey]));
};
