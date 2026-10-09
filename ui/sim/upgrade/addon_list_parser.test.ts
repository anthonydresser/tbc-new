// The grammar pass (parseAddonListLines) is pure and tested directly; the
// database stage only needs lookupItemSpec/getEnchants, so the Database module
// and the items helpers are mocked rather than built for real.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadLeftovers = vi.hoisted(() => vi.fn());
const getDatabase = vi.hoisted(() => vi.fn());
vi.mock('@sim/proto/database', () => ({
	Database: { get: getDatabase, loadLeftoversIfNecessary: loadLeftovers },
}));

const getEligibleItemSlotsMock = vi.hoisted(() => vi.fn());
const enchantAppliesToItemMock = vi.hoisted(() => vi.fn());
vi.mock('@sim/proto/items', () => ({
	getEligibleItemSlots: getEligibleItemSlotsMock,
	enchantAppliesToItem: enchantAppliesToItemMock,
}));

import { addonListStringExample, parseAddonListLines, parseAddonUpgradeList } from './addon_list_parser';

const V2_STRING = [
	'WWSULv2|Fury Warrior Upgrades|Fury Warrior|1755800000|1523.4',
	'14:30358:Enchant Weapon - Mongoose:24061,24061:42.1',
	'0:28802::24027:12.0',
	'15:28795:::3.4',
].join('\n');

const V3_STRING = [
	'WWSULv3|Fury Warrior Upgrades|Fury Warrior|1755800000|1523.4|1680.0',
	'14:30358:Enchant Weapon - Mongoose:24061,24061:42.1:-98.7',
	'0:28802::24027:12.0:-130.8',
].join('\n');

describe('parseAddonListLines', () => {
	it('parses a v2 string with empty enchant and empty gem fields', () => {
		const result = parseAddonListLines(V2_STRING);

		expect(result.errors).toEqual([]);
		expect(result.listName).toBe('Fury Warrior Upgrades');
		expect(result.specName).toBe('Fury Warrior');
		expect(result.rows.map(r => r.itemId)).toEqual([30358, 28802, 28795]);
		expect(result.rows[0].enchantName).toBe('Enchant Weapon - Mongoose');
		expect(result.rows[0].gemIds).toEqual([24061, 24061]);
		expect(result.rows[1].enchantName).toBe('');
		expect(result.rows[2].gemIds).toEqual([]);
	});

	it('parses v3 rows that carry the extra vs-BiS field', () => {
		const result = parseAddonListLines(V3_STRING);
		expect(result.errors).toEqual([]);
		expect(result.rows).toHaveLength(2);
	});

	it('tolerates CRLF line endings and surrounding whitespace', () => {
		const result = parseAddonListLines(`  ${V2_STRING.replace(/\n/g, '\r\n')}\r\n  `);
		expect(result.errors).toEqual([]);
		expect(result.rows).toHaveLength(3);
	});

	it('unescapes doubled pipes from WoW editboxes', () => {
		const result = parseAddonListLines('WWSULv2||Warlock Upgrades||Warlock||1787351094||2367.0\n0:1::1:10.0');
		expect(result.errors).toEqual([]);
		expect(result.listName).toBe('Warlock Upgrades');
		expect(result.specName).toBe('Warlock');
	});

	it('rejects a missing header', () => {
		const result = parseAddonListLines('hello\n0:1::1:10.0');
		expect(result.rows).toEqual([]);
		expect(result.errors[0].type).toBe('invalid_format');
	});

	it('rejects empty and whitespace-only input', () => {
		expect(parseAddonListLines('').errors[0].type).toBe('invalid_format');
		expect(parseAddonListLines('  \n  ').errors[0].type).toBe('invalid_format');
	});

	it('rejects a newer format version', () => {
		const result = parseAddonListLines('WWSULv9|X|Y|1\n0:1::1:10.0');
		expect(result.rows).toEqual([]);
		expect(result.errors[0].type).toBe('unsupported_version');
	});

	it('collects malformed lines as errors without dropping valid rows', () => {
		const result = parseAddonListLines('WWSULv2|X|Y|1|100.0\n0:1::1:10.0\ngarbage line\n5:notanumber:::no');
		expect(result.rows.map(r => r.itemId)).toEqual([1]);
		expect(result.errors.filter(e => e.type === 'invalid_format')).toHaveLength(2);
	});

	it('dedupes repeated item ids', () => {
		const result = parseAddonListLines('WWSULv2|X|Y|1|100.0\n14:30358:::1.0\n14:30358:::5.5');
		expect(result.rows).toHaveLength(1);
	});

	it('flags out-of-range slots', () => {
		const result = parseAddonListLines('WWSULv2|X|Y|1|100.0\n17:1::1:10.0');
		expect(result.rows).toEqual([]);
		expect(result.errors[0].type).toBe('invalid_format');
	});

	it('reports a header with no items', () => {
		const result = parseAddonListLines('WWSULv2|X|Y|1|100.0');
		expect(result.rows).toEqual([]);
		expect(result.errors.some(e => e.type === 'invalid_format')).toBe(true);
	});
});

describe('parseAddonUpgradeList', () => {
	const MONGOOSE = { name: 'Enchant Weapon - Mongoose', effectId: 2673 };

	const makeItem = (id: number, name: string, sockets: number, slots: number[]) => ({
		id,
		name,
		// The mocked getEligibleItemSlots only reads .slots; gemSockets.length drives gem trimming.
		slots,
		gemSockets: Array.from({ length: sockets }, (_, i) => i + 1),
	});

	const itemDb = new Map<number, ReturnType<typeof makeItem>>([
		[30358, makeItem(30358, 'Blinkstrike', 0, [15, 16])],
		[28802, makeItem(28802, 'Gladiator Helm', 2, [0])],
	]);

	beforeEach(() => {
		loadLeftovers.mockReset().mockResolvedValue(undefined);
		getEligibleItemSlotsMock.mockReset().mockImplementation((item: any) => item.slots);
		enchantAppliesToItemMock.mockReset().mockReturnValue(true);
		getDatabase.mockReset().mockResolvedValue({
			lookupItemSpec: (spec: any) => (itemDb.has(spec.id) ? { item: itemDb.get(spec.id) } : null),
			getEnchants: (slot: number) => (slot === 15 || slot === 16 ? [MONGOOSE] : []),
		});
	});

	it('loads leftovers before resolving items', async () => {
		await parseAddonUpgradeList(V2_STRING);
		expect(loadLeftovers).toHaveBeenCalledTimes(1);
	});

	it('does not touch the database when grammar parsing fails', async () => {
		const result = await parseAddonUpgradeList('junk');
		expect(result.errors[0].type).toBe('invalid_format');
		expect(loadLeftovers).not.toHaveBeenCalled();
	});

	it('resolves enchants by display name, case-insensitively', async () => {
		const lower = V3_STRING.replace('Enchant Weapon - Mongoose', 'enchant weapon - mongoose');
		const result = await parseAddonUpgradeList(lower);

		const weapon = result.candidates.find(c => c.spec.id === 30358);
		expect(weapon?.enchant).toBe(MONGOOSE);
		const helm = result.candidates.find(c => c.spec.id === 28802);
		expect(helm?.enchant).toBeNull();
		expect(result.errors.filter(e => e.type === 'enchant_not_found')).toHaveLength(0);
	});

	it('records a warning and no enchant when the name does not match', async () => {
		const renamed = V2_STRING.replace('Enchant Weapon - Mongoose', 'Enchant Weapon - No Such Thing');
		const result = await parseAddonUpgradeList(renamed);

		const weapon = result.candidates.find(c => c.spec.id === 30358);
		expect(weapon?.enchant).toBeNull();
		expect(result.errors.some(e => e.type === 'enchant_not_found')).toBe(true);
	});

	it('trims gem ids to the item socket count', async () => {
		const result = await parseAddonUpgradeList(V2_STRING); // 30358 has 0 sockets, 2 gem ids listed
		const weapon = result.candidates.find(c => c.spec.id === 30358);
		expect(weapon?.spec.gems).toEqual([]);
		const helm = result.candidates.find(c => c.spec.id === 28802);
		expect(helm?.spec.gems).toEqual([24027]);
	});

	it('reports unknown items and keeps the rest', async () => {
		const result = await parseAddonUpgradeList(V2_STRING); // contains 28795, not in the db
		expect(result.candidates.map(c => c.spec.id).sort()).toEqual([28802, 30358]);
		expect(result.errors.some(e => e.type === 'item_not_found')).toBe(true);
	});

	it('flags slot mismatches without dropping the candidate', async () => {
		// 28802 is head-only; the export claims slot 7.
		const result = await parseAddonUpgradeList('WWSULv2|X|Y|1|100.0\n7:28802::24027:10.0');
		expect(result.candidates).toHaveLength(1);
		expect(result.errors.some(e => e.type === 'slot_mismatch')).toBe(true);
	});

	it('the dialog example parses cleanly with a realistic database', async () => {
		const result = await parseAddonUpgradeList(addonListStringExample());
		expect(result.errors.some(e => e.type === 'invalid_format')).toBe(false);
	});
});
