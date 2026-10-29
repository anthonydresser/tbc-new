import { usePlayer } from '@sim/context/SimHostContext';
import type { InventorySlice } from '@sim/state/sim_store';
import { useStore } from 'zustand';

// The slice can be absent before initInventory seeds it (tests, non-sim pages), so
// selectors receive undefined and should fall back to an empty shape.
export const useInventoryState = <T>(selector: (slice: InventorySlice | undefined) => T): T => {
	const player = usePlayer();
	return useStore(player.sim.store, state => selector(state.inventory[player.storeKey]));
};
