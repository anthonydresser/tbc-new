// Parses the WoWSimsUpgradeList addon string (WWSULv2/v3) back into upgrade
// candidates. That is the same grammar addon_export.ts emits and the addon
// re-serializes for its in-game Export popup, so strings from either source —
// or saved copies of the original sim export — all work here.
//
//	WWSULv2|<listName>|<specFriendlyName>|<unixTimestamp>|<baselineDps>
//	<slot>:<itemId>:<enchantNameOrEmpty>:<gemId1>,<gemId2>,...:<delta>
//	WWSULv3 adds |<bisDps> to the header and :<vsBisDelta> to each row.
//
// Deltas, baseline and BiS DPS are metadata for the in-game display; they are
// parsed but intentionally discarded — the import only repopulates candidates.
import { EquipmentSpec, ItemSlot, ItemSpec } from '@generated/proto/common';
import type { UIEnchant } from '@generated/proto/ui';
import { Database } from '@sim/proto/database';
import { enchantAppliesToItem, getEligibleItemSlots } from '@sim/proto/items';

export interface AddonListParseError {
	type: 'invalid_format' | 'unsupported_version' | 'item_not_found' | 'enchant_not_found' | 'slot_mismatch';
	message: string;
}

export interface AddonListCandidate {
	spec: ItemSpec;
	enchant: UIEnchant | null;
}

export interface AddonListParseResult {
	listName: string;
	specName: string;
	candidates: AddonListCandidate[];
	errors: AddonListParseError[];
}

interface AddonListRow {
	slot: number;
	itemId: number;
	enchantName: string;
	gemIds: number[];
}

interface ParsedAddonList {
	listName: string;
	specName: string;
	rows: AddonListRow[];
	errors: AddonListParseError[];
}

const HEADER_PATTERN = /^WWSULv(\d+)$/;
const SUPPORTED_FORMAT_VERSION = 3;
// The optional v3 :<vsBisDelta> suffix is matched separately because it does not
// need to agree with the header version — the row grammar is otherwise identical
// and deltas are discarded anyway.
const ITEM_LINE_PATTERN = /^(\d{1,2}):(\d+):([^:]*):([^:]*):(-?\d+(?:\.\d+)?)(?::-?\d+(?:\.\d+)?)?$/;

// Pure grammar pass: text in, header + rows + errors out. No database access.
export const parseAddonListLines = (data: string): ParsedAddonList => {
	const fail = (type: AddonListParseError['type'], message: string): ParsedAddonList => ({
		listName: '',
		specName: '',
		rows: [],
		errors: [{ type, message }],
	});

	if (typeof data !== 'string' || !data.trim()) {
		return fail('invalid_format', 'Nothing to import — paste the export string first.');
	}
	// WoW editboxes escape "|" as "||" in stored text; undo that before parsing.
	// Names contain no pipes by construction (the sim sanitizes them), so every
	// surviving pipe is a delimiter.
	const text = data.trim().replace(/\|\|/g, '|');

	const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
	if (lines.length === 0) {
		return fail('invalid_format', 'Nothing to import — paste the export string first.');
	}

	const fields = lines[0].split('|');
	const versionMatch = fields[0]?.match(HEADER_PATTERN);
	if (!versionMatch) {
		return fail('invalid_format', 'This does not look like a WoWSims Upgrade List export (missing WWSULvN header).');
	}
	const version = parseInt(versionMatch[1], 10);
	if (version > SUPPORTED_FORMAT_VERSION) {
		return fail(
			'unsupported_version',
			`This export uses a newer format version (v${version}); update the sim or re-export.`,
		);
	}

	const errors: AddonListParseError[] = [];
	const rows: AddonListRow[] = [];
	const seenIds = new Set<number>();

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		const match = line.match(ITEM_LINE_PATTERN);
		if (!match) {
			if (line !== '') {
				errors.push({ type: 'invalid_format', message: `Line ${i + 1} is malformed: "${line.slice(0, 60)}"` });
			}
			continue;
		}
		const slot = parseInt(match[1], 10);
		const itemId = parseInt(match[2], 10);
		const enchantName = match[3].trim();
		const gemIds = match[4]
			.split(',')
			.map(g => parseInt(g.trim(), 10))
			.filter(g => !isNaN(g) && g > 0);
		if (slot < 0 || slot > ItemSlot.ItemSlotRanged || itemId <= 0) {
			errors.push({ type: 'invalid_format', message: `Line ${i + 1} has an out-of-range slot or item id: "${line.slice(0, 60)}"` });
			continue;
		}
		if (seenIds.has(itemId)) continue; // the addon itself dedupes per item id
		seenIds.add(itemId);
		rows.push({ slot, itemId, enchantName, gemIds });
	}

	if (rows.length === 0 && errors.length === 0) {
		errors.push({ type: 'invalid_format', message: 'No valid item lines found in the export.' });
	}

	return { listName: fields[1] ?? '', specName: fields[2] ?? '', rows, errors };
};

// Resolves an enchant by its display name against the item's eligible slots.
// Returns null silently for an empty name (the enchant field is optional);
// callers decide whether a non-empty unmatched name is worth a warning.
const findEnchantByName = (db: Database, slot: ItemSlot, itemSlots: ItemSlot[], name: string): UIEnchant | null => {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return null;
	const searchOrder = [slot, ...itemSlots.filter(s => s !== slot)];
	for (const searchSlot of searchOrder) {
		const enchant = db.getEnchants(searchSlot).find(e => e.name.trim().toLowerCase() === normalized);
		if (enchant) return enchant;
	}
	return null;
};

export async function parseAddonUpgradeList(data: string): Promise<AddonListParseResult> {
	const grammar = parseAddonListLines(data);
	const result: AddonListParseResult = {
		listName: grammar.listName,
		specName: grammar.specName,
		candidates: [],
		errors: [...grammar.errors],
	};
	if (grammar.rows.length === 0) {
		if (result.errors.length === 0) {
			result.errors.push({ type: 'invalid_format', message: 'No valid item lines found in the export.' });
		}
		return result;
	}

	const db = await Database.get();
	// Exports may reference items that live only in the leftover database.
	await Database.loadLeftoversIfNecessary(EquipmentSpec.create({ items: grammar.rows.map(row => ItemSpec.create({ id: row.itemId })) }));

	for (const row of grammar.rows) {
		const equippedItem = db.lookupItemSpec(ItemSpec.create({ id: row.itemId }));
		if (!equippedItem) {
			result.errors.push({
				type: 'item_not_found',
				message: `Item id ${row.itemId} could not be found in the database.`,
			});
			continue;
		}
		const item = equippedItem.item;
		const eligibleSlots = getEligibleItemSlots(item);

		// Extra gem ids beyond the socket count are ignored by the run path anyway;
		// drop them here so the candidate carries exactly what the item can hold.
		const gems = row.gemIds.slice(0, item.gemSockets.length);
		const spec = ItemSpec.create({ id: row.itemId, gems });

		let enchant: UIEnchant | null = null;
		if (row.enchantName) {
			enchant = findEnchantByName(db, row.slot as ItemSlot, eligibleSlots, row.enchantName);
			// A name collision across slots could match an enchant the item can't take.
			if (enchant && !enchantAppliesToItem(enchant, item)) enchant = null;
			if (!enchant) {
				result.errors.push({
					type: 'enchant_not_found',
					message: `Enchant "${row.enchantName}" for item id ${row.itemId} could not be matched; the candidate is added without an enchant.`,
				});
			}
		}

		if (!eligibleSlots.includes(row.slot as ItemSlot)) {
			result.errors.push({
				type: 'slot_mismatch',
				message: `Item "${item.name}" (id ${row.itemId}) does not fit slot ${row.slot}; it will be placed in an eligible slot.`,
			});
		}

		result.candidates.push({ spec, enchant });
	}

	return result;
}

export function addonListStringExample(): string {
	return [
		'WWSULv3|Fury Warrior Upgrades|Fury Warrior|1755800000|1523.4|1680.0',
		'14:30358:Enchant Weapon - Mongoose:24061,24061:42.1:-98.7',
		'0:28802::24027:12.0:-130.8',
	].join('\n');
}
