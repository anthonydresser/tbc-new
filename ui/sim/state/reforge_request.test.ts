// The gem cache key covers what can change the gems the optimizer chooses. A stat constraint does so
// only as a row of its model, and a constraint on a resistance can only be a row when a gem in the
// pool carries that resistance and the spec gems for it; otherwise it is decided on the stats alone.
import { BulkStatConstraint, BulkStatConstraintOp, ReforgeGemOption, ReforgeOptimizeRequest, ReforgeSettings } from '@generated/proto/api';
import { GemColor, Stat } from '@generated/proto/common';
import { describe, expect, it } from 'vitest';

import { cacheRelevantReforgeRequest } from './reforge_request';

const STATS_LEN = Stat.StatShadowResistance + 1;
const gem = (id: number, statValues: Partial<Record<Stat, number>>) => {
	const values = new Array(STATS_LEN).fill(0);
	for (const [stat, value] of Object.entries(statValues)) values[Number(stat)] = value;
	return ReforgeGemOption.create({ id, color: GemColor.GemColorPrismatic, stats: values });
};
const VOID_SPHERE = gem(22459, {
	[Stat.StatArcaneResistance]: 4,
	[Stat.StatFireResistance]: 4,
	[Stat.StatFrostResistance]: 4,
	[Stat.StatNatureResistance]: 4,
	[Stat.StatShadowResistance]: 4,
});
const SOLID_STAR = gem(24033, { [Stat.StatStamina]: 12 });

const atLeast = (stat: Stat, value: number) =>
	BulkStatConstraint.create({ unitStat: { oneofKind: 'stat', stat }, op: BulkStatConstraintOp.BulkStatConstraintOpGreaterThanOrEqual, value });

const key = (constraint: BulkStatConstraint, { epStats = [Stat.StatStamina], gemOptions = [VOID_SPHERE, SOLID_STAR] } = {}) =>
	ReforgeOptimizeRequest.toJsonString(
		cacheRelevantReforgeRequest(
			ReforgeOptimizeRequest.create({ settings: ReforgeSettings.create({ epStats }), gemOptions, statConstraints: [constraint] }),
		),
	);

describe('cacheRelevantReforgeRequest', () => {
	it('leaves out a resistance constraint the spec does not gem for', () => {
		expect(key(atLeast(Stat.StatFireResistance, 175))).toBe(key(atLeast(Stat.StatFireResistance, 180)));
	});

	it('leaves out a resistance constraint no gem in the pool carries', () => {
		const options = { epStats: [Stat.StatStamina, Stat.StatFireResistance], gemOptions: [SOLID_STAR] };
		expect(key(atLeast(Stat.StatFireResistance, 175), options)).toBe(key(atLeast(Stat.StatFireResistance, 180), options));
	});

	it('keeps a resistance constraint a gem can meet', () => {
		const options = { epStats: [Stat.StatStamina, Stat.StatFireResistance] };
		expect(key(atLeast(Stat.StatFireResistance, 175), options)).not.toBe(key(atLeast(Stat.StatFireResistance, 180), options));
	});

	it('keeps every other constraint', () => {
		expect(key(atLeast(Stat.StatStamina, 500))).not.toBe(key(atLeast(Stat.StatStamina, 600)));
	});
});
