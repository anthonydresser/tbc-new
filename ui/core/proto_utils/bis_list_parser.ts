import { EquipmentSpec, ItemSlot, ItemSpec } from '../proto/common';
import { Database } from './database';

export interface BisListItemEntryJson {
	id?: number;
	name?: string;
	enchant?: number;
	gems?: number[];
	randomSuffix?: number;
	note?: string;
}

export interface BisListJson {
	version?: number;
	slots: Record<string, BisListItemEntryJson[]>;
	metadata?: Record<string, any>;
}

export interface BisListParseError {
	type: 'invalid_json' | 'invalid_slot' | 'missing_id_or_name' | 'item_not_found' | 'duplicate_item';
	message: string;
	slot?: string;
	entry?: BisListItemEntryJson;
}

export interface BisListParseResult {
	itemSpecs: ItemSpec[];
	errors: BisListParseError[];
}

const SLOT_NAME_ALIASES: Record<string, ItemSlot> = {
	head: ItemSlot.ItemSlotHead,
	neck: ItemSlot.ItemSlotNeck,
	shoulder: ItemSlot.ItemSlotShoulder,
	back: ItemSlot.ItemSlotBack,
	chest: ItemSlot.ItemSlotChest,
	wrist: ItemSlot.ItemSlotWrist,
	hands: ItemSlot.ItemSlotHands,
	waist: ItemSlot.ItemSlotWaist,
	legs: ItemSlot.ItemSlotLegs,
	feet: ItemSlot.ItemSlotFeet,
	finger: ItemSlot.ItemSlotFinger1,
	finger1: ItemSlot.ItemSlotFinger1,
	finger_1: ItemSlot.ItemSlotFinger1,
	finger2: ItemSlot.ItemSlotFinger2,
	finger_2: ItemSlot.ItemSlotFinger2,
	trinket: ItemSlot.ItemSlotTrinket1,
	trinket1: ItemSlot.ItemSlotTrinket1,
	trinket_1: ItemSlot.ItemSlotTrinket1,
	trinket2: ItemSlot.ItemSlotTrinket2,
	trinket_2: ItemSlot.ItemSlotTrinket2,
	mainhand: ItemSlot.ItemSlotMainHand,
	main_hand: ItemSlot.ItemSlotMainHand,
	mainHand: ItemSlot.ItemSlotMainHand,
	offhand: ItemSlot.ItemSlotOffHand,
	off_hand: ItemSlot.ItemSlotOffHand,
	offHand: ItemSlot.ItemSlotOffHand,
	ranged: ItemSlot.ItemSlotRanged,
};

function normalizeSlotKey(key: string): ItemSlot | undefined {
	return SLOT_NAME_ALIASES[key.toLowerCase()];
}

function parseGems(gems: any): number[] | undefined {
	if (!gems) return undefined;
	if (!Array.isArray(gems)) return undefined;
	return gems.filter(g => typeof g === 'number' && g > 0).map(g => g as number);
}

function createItemSpec(entry: BisListItemEntryJson, itemId: number): ItemSpec {
	return ItemSpec.create({
		id: itemId,
		enchant: entry.enchant || 0,
		gems: parseGems(entry.gems) || [],
		randomSuffix: entry.randomSuffix || 0,
	});
}

async function resolveName(db: Database, name: string): Promise<number | undefined> {
	const normalized = name.trim().toLowerCase();

	// Search the main database first.
	for (const item of db.getAllItems()) {
		if (item.name.trim().toLowerCase() === normalized) {
			return item.id;
		}
	}

	// Fall back to the leftover database without loading it into the main DB.
	try {
		const leftoverDb = await Database.getLeftovers();
		for (const item of leftoverDb.items) {
			if (item.name.trim().toLowerCase() === normalized) {
				return item.id;
			}
		}
	} catch {
		// Ignore leftover load failures; the item is simply not found.
	}

	return undefined;
}

export async function parseBisListJson(data: string): Promise<BisListParseResult> {
	let parsed: any;
	try {
		parsed = JSON.parse(data);
	} catch (e) {
		return {
			itemSpecs: [],
			errors: [{ type: 'invalid_json', message: `Invalid JSON: ${(e as Error).message}` }],
		};
	}

	if (!parsed || typeof parsed !== 'object' || !parsed.slots || typeof parsed.slots !== 'object') {
		return {
			itemSpecs: [],
			errors: [{ type: 'invalid_json', message: 'BiS list must be an object with a "slots" property.' }],
		};
	}

	const db = await Database.get();
	const itemSpecs: ItemSpec[] = [];
	const errors: BisListParseError[] = [];
	const seenIds = new Set<number>();

	// First pass: resolve every entry to an item ID (or record an error).
	const resolvedSpecs: { slot: string; spec: ItemSpec; entry: BisListItemEntryJson }[] = [];

	for (const [slotKey, entries] of Object.entries(parsed.slots as Record<string, any[]>)) {
		const slot = normalizeSlotKey(slotKey);
		if (slot === undefined) {
			errors.push({
				type: 'invalid_slot',
				message: `Unknown slot "${slotKey}".`,
				slot: slotKey,
			});
			continue;
		}

		if (!Array.isArray(entries)) {
			errors.push({
				type: 'invalid_json',
				message: `Slot "${slotKey}" must contain an array of item entries.`,
				slot: slotKey,
			});
			continue;
		}

		for (const entry of entries) {
			if (!entry || typeof entry !== 'object') {
				errors.push({
					type: 'invalid_json',
					message: `Invalid entry in slot "${slotKey}".`,
					slot: slotKey,
					entry,
				});
				continue;
			}

			let itemId: number | undefined;
			if (typeof entry.id === 'number' && entry.id > 0) {
				itemId = entry.id;
			} else if (typeof entry.name === 'string' && entry.name.trim().length > 0) {
				itemId = await resolveName(db, entry.name);
				if (itemId === undefined) {
					errors.push({
						type: 'item_not_found',
						message: `Item "${entry.name}" could not be found.`,
						slot: slotKey,
						entry,
					});
					continue;
				}
			} else {
				errors.push({
					type: 'missing_id_or_name',
					message: `Entry in slot "${slotKey}" must have an "id" or "name".`,
					slot: slotKey,
					entry,
				});
				continue;
			}

			if (itemId === undefined) continue;

			if (seenIds.has(itemId)) {
				errors.push({
					type: 'duplicate_item',
					message: `Item "${entry.name || itemId}" is listed more than once.`,
					slot: slotKey,
					entry,
				});
				continue;
			}
			seenIds.add(itemId);

			resolvedSpecs.push({ slot: slotKey, spec: createItemSpec(entry, itemId), entry });
		}
	}

	// Ensure the leftover DB is loaded if any resolved item ID is missing.
	if (resolvedSpecs.length > 0) {
		const equipmentSpec = EquipmentSpec.create({
			items: resolvedSpecs.map(r => r.spec),
		});
		await Database.loadLeftoversIfNecessary(equipmentSpec);
	}

	// Final pass: verify every spec can be looked up in the (now complete) database.
	for (const { slot, spec, entry } of resolvedSpecs) {
		const equippedItem = db.lookupItemSpec(spec);
		if (!equippedItem) {
			errors.push({
				type: 'item_not_found',
				message: `Item "${entry.name || spec.id}" (id: ${spec.id}) could not be found in the database.`,
				slot,
				entry,
			});
			continue;
		}
		itemSpecs.push(spec);
	}

	return { itemSpecs, errors };
}

export function bisListJsonExample(): string {
	return JSON.stringify(
		{
			version: 1,
			slots: {
				head: [{ id: 30132, enchant: 29191, gems: [32409, 24027] }],
				shoulder: [
					{ id: 30133, enchant: 28888 },
					{ id: 30053 },
				],
				mainHand: [{ id: 29993, enchant: 27977 }],
			},
			metadata: {
				name: 'Example BiS List',
			},
		},
		null,
		2,
	);
}
