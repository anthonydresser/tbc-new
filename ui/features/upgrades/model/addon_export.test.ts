// The exporter only reads the upgrades slice (baseline/results/bisResult), the
// inventory slice (owned ids) and the spec's friendly name, so a stubbed player
// with seeded store slices is enough.
import { ItemSpec } from '@generated/proto/common';
import type { Player } from '@sim/player/player';
import { patchInventoryState, seedInventorySettings } from '@sim/settings/inventory_settings';
import { patchUpgradeState, seedUpgradeSettings } from '@sim/settings/upgrade_settings';
import { createSimStore } from '@sim/state/sim_store';
import type { UpgradeResult } from '@sim/upgrade/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { UPGRADE_ADDON_EXPORTER } from './addon_export';

const STORE_KEY = 0;

let player: Player<any>;

const fakeResult = (itemId: number, delta: number, bisDelta?: number, zoneIds: Array<number> = []): UpgradeResult =>
	({
		item: {
			item: {
				id: itemId,
				sources: zoneIds.map(zoneId => ({ source: { oneofKind: 'drop', drop: { zoneId } } })),
			},
			enchant: null,
			gems: [],
		},
		slot: 0,
		dpsMetrics: { avg: 1600 },
		delta,
		bisDelta,
	}) as unknown as UpgradeResult;

// getData's categories argument is unused by this exporter.
const exportLines = (host: unknown) => UPGRADE_ADDON_EXPORTER.getData(host as never, {} as never).split('\n');

beforeEach(() => {
	const store = createSimStore();
	player = {
		storeKey: STORE_KEY,
		sim: { store },
		getPlayerSpec: () => ({ friendlyName: 'Fury Warrior' }),
	} as unknown as Player<any>;
	seedInventorySettings(player);
	seedUpgradeSettings(player);
});

describe('UPGRADE_ADDON_EXPORTER', () => {
	it('emits nothing without a completed run', () => {
		expect(UPGRADE_ADDON_EXPORTER.getData({ player } as never, {} as never)).toBe('');
	});

	it('stays v2 with no BiS reference and no owned results', () => {
		patchUpgradeState(
			player,
			{ baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never, results: [fakeResult(100, 42.1)] },
			['results'],
		);

		const lines = exportLines({ player });
		expect(lines[0]).toMatch(/^WWSULv2\|Fury Warrior Upgrades\|Fury Warrior\|\d+\|1523\.4$/);
		expect(lines[1]).toBe('0:100:::42.1');
	});

	it('stays v3 with a BiS reference but no owned results', () => {
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				bisResult: { gear: null, dpsMetrics: { avg: 1680 } } as never,
				results: [fakeResult(100, 42.1, -98.7)],
			},
			['results'],
		);

		const lines = exportLines({ player });
		expect(lines[0]).toMatch(/^WWSULv3\|.*\|1680\.0$/);
		expect(lines[1]).toBe('0:100:::42.1:-98.7');
	});

	it('bumps to v4 with a trailing owned flag when a result is owned', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				bisResult: { gear: null, dpsMetrics: { avg: 1680 } } as never,
				results: [fakeResult(100, 42.1, -98.7), fakeResult(200, 12.0, -130.8)],
			},
			['results'],
		);

		const lines = exportLines({ player });
		expect(lines[0]).toMatch(/^WWSULv4\|.*\|1680\.0$/);
		expect(lines[1]).toBe('0:100:::42.1:-98.7:1');
		expect(lines[2]).toBe('0:200:::12.0:-130.8:0');
	});

	it('keeps the owned flag in position with an empty vs-BiS field when there is no BiS run', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		patchUpgradeState(
			player,
			{ baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never, results: [fakeResult(100, 42.1), fakeResult(200, 12.0)] },
			['results'],
		);

		const lines = exportLines({ player });
		expect(lines[0]).toMatch(/^WWSULv4\|Fury Warrior Upgrades\|Fury Warrior\|\d+\|1523\.4$/);
		expect(lines[1]).toBe('0:100:::42.1::1');
		expect(lines[2]).toBe('0:200:::12.0::0');
	});

	it('omits rows hidden by the owned or non-upgrades filters', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				results: [fakeResult(100, 42.1), fakeResult(200, -30.5), fakeResult(300, 0), fakeResult(400, 12.0)],
				hideOwnedResults: true,
				hideNonUpgrades: true,
			},
			['settings', 'results'],
		);

		const lines = exportLines({ player });
		// 100 is owned and hidden, 200/300 are non-upgrades; only 400 remains, and
		// with no displayed owned row the format drops back to v2.
		expect(lines[0]).toMatch(/^WWSULv2\|/);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe('0:400:::12.0');
	});

	it('never exports equipped-already marker rows, upgrade delta or not', () => {
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				results: [
					{ ...fakeResult(100, 0), equippedAlready: true } as UpgradeResult,
					fakeResult(200, 12.0),
					fakeResult(300, -4.0),
				],
				hideNonUpgrades: true,
			},
			['settings', 'results'],
		);

		const lines = exportLines({ player });
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe('0:200:::12.0');
	});

	it('bumps to v5 with a trailing zone-id list when a displayed result drops somewhere', () => {
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				results: [fakeResult(100, 42.1, undefined, [3959]), fakeResult(200, 12.0, undefined, [3959, 3606]), fakeResult(300, 5.0)],
			},
			['results'],
		);

		const lines = exportLines({ player });
		// v5 rows always carry the vs-BiS field (empty without a BiS run), the owned
		// flag, and the zone list (empty for non-drop items like 300).
		expect(lines[0]).toMatch(/^WWSULv5\|Fury Warrior Upgrades\|Fury Warrior\|\d+\|1523\.4$/);
		expect(lines[1]).toBe('0:100:::42.1::0:3959');
		expect(lines[2]).toBe('0:200:::12.0::0:3959,3606');
		expect(lines[3]).toBe('0:300:::5.0::0:');
	});

	it('keeps the zones behind the vs-BiS and owned positions with a BiS run', () => {
		patchInventoryState(player, { items: [ItemSpec.create({ id: 100 })] }, ['items']);
		patchUpgradeState(
			player,
			{
				baseline: { gear: null, dpsMetrics: { avg: 1523.4 } } as never,
				bisResult: { gear: null, dpsMetrics: { avg: 1680 } } as never,
				results: [fakeResult(100, 42.1, -98.7, [3959])],
			},
			['results'],
		);

		const lines = exportLines({ player });
		expect(lines[0]).toMatch(/^WWSULv5\|.*\|1680\.0$/);
		expect(lines[1]).toBe('0:100:::42.1:-98.7:1:3959');
	});
});
