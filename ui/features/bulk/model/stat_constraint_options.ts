import { BulkStatConstraint, BulkStatConstraintOp } from '@generated/proto/api';
import { PseudoStat, Stat } from '@generated/proto/common';
import { displayStatOrder, UnitStat } from '@sim/proto/stats';

// What the stat constraints picker offers: the selectable stats in character sheet order, the
// operators, and the option-value encoding of a stat. Stats are labelled with UnitStat.getShortName,
// the translated names the rest of the UI uses.

// The Stat or PseudoStat a constraint applies to. Legacy rows saved before the
// oneof existed carry a bare stat, which the oneof still decodes.
export const constraintUnitStat = (constraint: BulkStatConstraint): UnitStat => {
	if (constraint.unitStat.oneofKind === 'pseudoStat') {
		return UnitStat.fromPseudoStat(constraint.unitStat.pseudoStat);
	}
	return UnitStat.fromStat(constraint.unitStat.oneofKind === 'stat' ? constraint.unitStat.stat : Stat.StatStamina);
};

export const withConstraintUnitStat = (constraint: BulkStatConstraint, unitStat: UnitStat): BulkStatConstraint => {
	const next = BulkStatConstraint.clone(constraint);
	next.unitStat = unitStat.isPseudoStat()
		? { oneofKind: 'pseudoStat', pseudoStat: unitStat.getPseudoStat() }
		: { oneofKind: 'stat', stat: unitStat.getStat() };
	return next;
};

// Crit reduction is not a character-sheet stat (the sheet shows it as "Crit
// Immunity"), so it is added here explicitly, right after Defense.
const CRIT_REDUCTION = UnitStat.fromPseudoStat(PseudoStat.PseudoStatReducedCritTakenPercent);

// Stats offered in the dropdown, in the same order the character sheet uses.
export const SELECTABLE_STATS: UnitStat[] = displayStatOrder.flatMap(unitStat =>
	unitStat.equalsStat(Stat.StatDefenseRating) ? [unitStat, CRIT_REDUCTION] : [unitStat],
);

export const unitStatOptionValue = (unitStat: UnitStat): string => (unitStat.isPseudoStat() ? `p${unitStat.getPseudoStat()}` : `s${unitStat.getStat()}`);
export const unitStatFromOptionValue = (value: string): UnitStat =>
	value.startsWith('p') ? UnitStat.fromPseudoStat(Number(value.slice(1)) as PseudoStat) : UnitStat.fromStat(Number(value.slice(1)) as Stat);

export const STAT_CONSTRAINT_OPS: BulkStatConstraintOp[] = [
	BulkStatConstraintOp.BulkStatConstraintOpGreaterThan,
	BulkStatConstraintOp.BulkStatConstraintOpGreaterThanOrEqual,
	BulkStatConstraintOp.BulkStatConstraintOpEqual,
	BulkStatConstraintOp.BulkStatConstraintOpLessThanOrEqual,
	BulkStatConstraintOp.BulkStatConstraintOpLessThan,
];
