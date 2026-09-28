// Reforge-solve request/cache-key helpers, extracted from the ReforgeOptimizer
// component so the domain layer (sim.ts, bulk sim, reforge cache) does not
// depend on the view layer.
import { BulkStatConstraint, Player as PlayerProtoMessageType, ReforgeOptimizeMode, ReforgeOptimizeRequest } from '@generated/proto/api';
import { Debuffs, GemColor, ItemQuality, PartyBuffs, Profession, RaidBuffs, Stat } from '@generated/proto/common';
import { UIGem as Gem } from '@generated/proto/ui';

import { ReforgeGearCache } from '../cache/reforge_cache';
import { SimSettingCategories } from '../constants/sim_settings';
import type { Player } from '../player/player';
import { Database } from '../proto/database';
import type { ReforgeOptimizeConfig } from '../sim';
import { distinct } from '../utils/collections';

// The player state a reforge solve depends on: the listed setting categories, plus bonus
// stats and item-swap config, minus fields that are either keyed separately (equipment),
// derivable (database), or irrelevant to a solve.
function cacheRelevantPlayerProto(player: Player<any>): PlayerProtoMessageType {
	const playerProto = player.toProto(true, false, [
		SimSettingCategories.Talents,
		SimSettingCategories.Consumes,
		SimSettingCategories.External,
		SimSettingCategories.Miscellaneous,
	]);
	playerProto.bonusStats = player.getBonusStats().toProto();
	playerProto.enableItemSwap = player.itemSwapSettings.getEnableItemSwap();
	playerProto.itemSwap = player.itemSwapSettings.toProto();
	playerProto.equipment = undefined;
	playerProto.database = undefined;
	playerProto.channelClipDelayMs = 0;
	playerProto.inFrontOfTarget = false;
	playerProto.distanceFromTarget = 0;
	playerProto.healingModel = undefined;
	return playerProto;
}

// The optimizer config a solve depends on: everything except per-run identity
// (requestId, debug, mode) and the raid, which is keyed separately. Gem options are
// order-normalized so equal sets hash equally.
const RESISTANCE_STATS: ReadonlySet<Stat> = new Set([
	Stat.StatArcaneResistance,
	Stat.StatFireResistance,
	Stat.StatFrostResistance,
	Stat.StatNatureResistance,
	Stat.StatShadowResistance,
]);

// Whether a batch stat constraint can change the gems the optimizer chooses, and so belongs in the
// cache key. It can only as a row of the model, and a row needs a gem that moves the stat. Nothing
// but a gem carrying a resistance moves one, and the optimizer only uses a gem if the spec gems for
// every stat it carries, so a resistance constraint without both is decided on the stats alone:
// changing it cannot change the gems. Any other stat can be moved through stat dependencies, which
// the key does not model, so those constraints are kept.
const constraintCanChangeGems = (constraint: BulkStatConstraint, reforgeRequest: ReforgeOptimizeRequest): boolean => {
	if (constraint.unitStat.oneofKind !== 'stat' || !RESISTANCE_STATS.has(constraint.unitStat.stat)) return true;
	const stat = constraint.unitStat.stat;
	const gemmedStats = reforgeRequest.settings?.epStats ?? [];
	if (!gemmedStats.length) return true; // An older client leaves the optimizer to derive them.
	return gemmedStats.includes(stat) && reforgeRequest.gemOptions.some(gem => (gem.stats[stat] ?? 0) > 0);
};

export function cacheRelevantReforgeRequest(reforgeRequest: ReforgeOptimizeRequest): ReforgeOptimizeRequest {
	const configForHash = ReforgeOptimizeRequest.clone({ ...reforgeRequest, raid: undefined } as ReforgeOptimizeRequest);
	configForHash.requestId = '';
	configForHash.debug = false;
	configForHash.mode = ReforgeOptimizeMode.ReforgeOptimizeModeSingle;
	configForHash.gemOptions = configForHash.gemOptions.sort((a, b) => a.id - b.id);
	configForHash.statConstraints = configForHash.statConstraints.filter(constraint => constraintCanChangeGems(constraint, reforgeRequest));
	return configForHash;
}

export async function getReforgeConfigHash({
	player,
	reforgeRequest,
	raidBuffs,
	partyBuffs,
	debuffs,
}: {
	player: Player<any>;
	reforgeRequest: ReforgeOptimizeRequest;
	raidBuffs: RaidBuffs;
	partyBuffs: PartyBuffs | undefined;
	debuffs: Debuffs;
}): Promise<string> {
	return ReforgeGearCache.getHash({
		player: PlayerProtoMessageType.toJsonString(cacheRelevantPlayerProto(player)),
		raid: {
			buffs: RaidBuffs.toJsonString(raidBuffs),
			partyBuffs: partyBuffs ? PartyBuffs.toJsonString(partyBuffs) : null,
			debuffs: Debuffs.toJsonString(debuffs),
		},
		optimizer: ReforgeOptimizeRequest.toJsonString(cacheRelevantReforgeRequest(reforgeRequest)),
	});
}

export function getReforgeGemOptions(db: Database): Gem[] {
	return distinct(
		[GemColor.GemColorRed, GemColor.GemColorBlue, GemColor.GemColorYellow]
			.flatMap(socketColor => db.getGems(socketColor))
			.filter(gem => !gem.name.includes('Perfect') && gem.quality >= ItemQuality.ItemQualityRare)
			.flat(),
		(a, b) => a.id == b.id,
	);
}

export function makeReforgeConfigRequestFields(config: ReforgeOptimizeConfig, db: Database) {
	return {
		preCapEpWeights: config.preCapEPWeights.toProto(),
		undershootCaps: config.undershootCaps.toProto(),
		settings: config.settings,
		softCaps: config.softCaps.map(softCap => ({
			unitStat: softCap.unitStat.toProto(),
			breakpoints: softCap.breakpoints.slice(),
			capType: softCap.capType,
			postCapEPs: softCap.postCapEPs.slice(),
		})),
		gemOptions: getReforgeGemOptions(db).map(gem => ({
			id: gem.id,
			name: gem.name,
			icon: gem.icon,
			color: gem.color,
			stats: gem.stats.slice(),
			phase: gem.phase,
			quality: gem.quality ?? ItemQuality.ItemQualityJunk,
			unique: gem.unique,
			requiredProfession: gem.requiredProfession ?? Profession.ProfessionUnknown,
		})),
	};
}
