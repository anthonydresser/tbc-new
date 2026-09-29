package reforgeoptimizer

import (
	"slices"
	"strconv"
	"strings"

	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
	"github.com/wowsims/tbc/sim/core/stats"
	googleProto "google.golang.org/protobuf/proto"
)

// gemLocation identifies one socket of one equipped item.
type gemLocation struct {
	slot      proto.ItemSlot
	socketIdx int
}

// applyLPSolution rebuilds the equipment from the solver's selected variables. Gem variables
// are keyed "<slot>_<socketIdx>_<gemID>"; every other selected variable (the SocketBonus_<slot>
// indicators) carries no gem and is skipped.
func (o *reforgeOptimizer) applyLPSolution(selectedVars []string) *proto.EquipmentSpec {
	gear := equipmentFromProto(o.baseStrippedGear)

	for _, variableKey := range selectedVars {
		parts := strings.Split(variableKey, "_")
		if len(parts) <= 2 {
			continue
		}
		slotIdx, err := strconv.Atoi(parts[0])
		if err != nil || slotIdx < 0 || slotIdx >= int(core.NumItemSlots) {
			continue
		}
		item := gear.GetItemBySlot(proto.ItemSlot(slotIdx))
		if item.ID == 0 {
			continue
		}
		socketIdx, socketErr := strconv.Atoi(parts[1])
		gemID, gemErr := strconv.Atoi(parts[2])
		if socketErr != nil || gemErr != nil {
			continue
		}
		setGemIDAt(item, socketIdx, int32(gemID))
	}

	o.minimizeRegems(gear)
	return gear.ToEquipmentSpecProto()
}

// minimizeRegems cuts the number of gems the player must actually buy. For each socket the
// solver changed, it locates where that socket's original gem now lives and swaps the two gems
// back — reusing a gem the player already owns instead of buying a new one — unless doing so would
// cost the socket bonuses the solver claimed.
func (o *reforgeOptimizer) minimizeRegems(newGear *core.Equipment) {
	if o.originalEquipment == nil {
		return
	}

	finalizedSocketKeys := map[reforgeSocketKey]bool{}
	for slotIdx := 0; slotIdx < int(core.NumItemSlots); slotIdx++ {
		slot := proto.ItemSlot(slotIdx)
		newItem := newGear.GetItemBySlot(slot)
		originalItem := o.originalEquipment.GetItemBySlot(slot)
		if newItem.ID == 0 || originalItem.ID == 0 {
			continue
		}

		for socketIdx := range currentSocketColors(*newItem) {
			socketKey := reforgeSocketKey{slot: slot, socketIdx: socketIdx}
			if finalizedSocketKeys[socketKey] || o.frozenSockets[socketKey] {
				continue
			}
			finalizedSocketKeys[socketKey] = true

			newGemID := gemIDAt(newItem, socketIdx)
			originalGemID := gemIDAt(originalItem, socketIdx)
			if newGemID == 0 || originalGemID == 0 || newGemID == originalGemID {
				continue
			}

			for _, loc := range o.findGem(newGear, originalGemID) {
				if o.frozenSlots[loc.slot] || o.frozenSockets[reforgeSocketKey{slot: loc.slot, socketIdx: loc.socketIdx}] {
					continue
				}
				matchedKey := reforgeSocketKey{slot: loc.slot, socketIdx: loc.socketIdx}
				if finalizedSocketKeys[matchedKey] {
					continue
				}
				matchedItem := newGear.GetItemBySlot(loc.slot)
				if loc.socketIdx >= len(currentSocketColors(*matchedItem)) {
					continue
				}
				// A swap moves gems between sockets without changing which gems are equipped, so
				// the only stats at stake are the two items' socket bonuses. Those are all-or-
				// nothing per ITEM, which is why a per-socket color-match count is not a safe
				// guard: shuffling one match off a fully-matched item onto a partly-matched one is
				// match-neutral yet loses a bonus outright. Require instead that the two items'
				// earned bonuses come out IDENTICAL, which is the condition under which the swap
				// is provably free. Scoring the two arrangements by EP would not be safe here: the
				// solver's caps live in the LP's constraints, not in its weights, so a pre-cap EP
				// comparison would happily trade an Intellect bonus for a Hit one the player is
				// already capped on.
				bonusIfKept := o.socketBonusStats(newItem).Add(o.socketBonusStats(matchedItem))
				setGemIDAt(newItem, socketIdx, originalGemID)
				setGemIDAt(matchedItem, loc.socketIdx, newGemID)
				bonusIfSwapped := o.socketBonusStats(newItem).Add(o.socketBonusStats(matchedItem))
				if bonusIfSwapped != bonusIfKept {
					setGemIDAt(newItem, socketIdx, newGemID)
					setGemIDAt(matchedItem, loc.socketIdx, originalGemID)
					continue
				}

				finalizedSocketKeys[matchedKey] = true
				break
			}
		}
	}
}

// findGemLP returns every socket into which the SOLVER moved gemID — i.e. a socket now holding
// gemID whose own original gem was something else. Sockets the solver never changed are skipped:
// they hold their rightful gem and must not be disturbed.
func (o *reforgeOptimizer) findGem(equipment *core.Equipment, gemID int32) []gemLocation {
	var locations []gemLocation
	for slotIdx := 0; slotIdx < int(core.NumItemSlots); slotIdx++ {
		slot := proto.ItemSlot(slotIdx)
		item := equipment.GetItemBySlot(slot)
		if item.ID == 0 {
			continue
		}
		var originalItem *core.Item
		if o.originalEquipment != nil {
			originalItem = o.originalEquipment.GetItemBySlot(slot)
		}
		for socketIdx := range currentSocketColors(*item) {
			if gemIDAt(item, socketIdx) != gemID {
				continue
			}
			if originalItem != nil && gemIDAt(originalItem, socketIdx) == gemID {
				continue
			}
			locations = append(locations, gemLocation{slot: slot, socketIdx: socketIdx})
		}
	}
	return locations
}

// socketBonusStats returns an item's socket bonus, or zero stats when the bonus is not earned.
// The bonus applies only when every colored socket holds a color-matching gem, mirroring the
// all-or-nothing rule the LP models via its SocketBonusLink constraints.
func (o *reforgeOptimizer) socketBonusStats(item *core.Item) stats.Stats {
	for socketIdx, socketColor := range currentSocketColors(*item) {
		if !isColoredSocket(socketColor) {
			continue
		}
		gem, ok := core.GetGemByID(gemIDAt(item, socketIdx))
		if !ok || !core.GemMatchesSocket(gem.Color, socketColor) {
			return stats.Stats{}
		}
	}
	return item.SocketBonus
}

func cloneEquipmentSpec(equipment *proto.EquipmentSpec) *proto.EquipmentSpec {
	if equipment == nil {
		return &proto.EquipmentSpec{}
	}
	return googleProto.Clone(equipment).(*proto.EquipmentSpec)
}

type reforgeSocketKey struct {
	slot      proto.ItemSlot
	socketIdx int
}

func gemIDAt(item *core.Item, socketIdx int) int32 {
	if item == nil || socketIdx >= len(item.Gems) {
		return 0
	}
	return item.Gems[socketIdx].ID
}

func setGemIDAt(item *core.Item, socketIdx int, gemID int32) {
	if item == nil {
		return
	}
	for len(item.Gems) <= socketIdx {
		item.Gems = append(item.Gems, core.Gem{})
	}
	item.Gems[socketIdx] = gemFromID(gemID)
}

func equipmentFromProto(equipment *proto.EquipmentSpec) *core.Equipment {
	if equipment == nil {
		return &core.Equipment{}
	}
	coreEquipment := core.ProtoToEquipment(equipment)
	return &coreEquipment
}

func gemFromID(gemID int32) core.Gem {
	if gemID == 0 {
		return core.Gem{}
	}
	if gem, ok := core.GetGemByID(gemID); ok {
		return gem
	}
	return core.Gem{ID: gemID}
}

func frozenItemSlots(settings *proto.ReforgeSettings) map[proto.ItemSlot]bool {
	frozen := map[proto.ItemSlot]bool{}
	if settings == nil || !settings.GetFreezeItemSlots() {
		return frozen
	}
	for _, item := range settings.GetFrozenItemSlots() {
		frozen[item] = true
	}
	return frozen
}

// frozenGemSocketKeys returns the individually frozen sockets. Frozen sockets keep whatever gem
// is currently socketed through optimization, exactly like frozen item slots do for the whole
// item.
func frozenGemSocketKeys(settings *proto.ReforgeSettings) map[reforgeSocketKey]bool {
	frozen := map[reforgeSocketKey]bool{}
	if settings == nil {
		return frozen
	}
	for _, socket := range settings.GetFrozenGemSockets() {
		frozen[reforgeSocketKey{slot: socket.GetSlot(), socketIdx: int(socket.GetSocketIdx())}] = true
	}
	return frozen
}

func currentSocketColors(item core.Item) []proto.GemColor {
	return slices.Clone(item.GemSockets)
}

func clearGems(equipment *proto.EquipmentSpec, settings *proto.ReforgeSettings) {
	frozenSlots := frozenItemSlots(settings)
	frozenSockets := frozenGemSocketKeys(settings)
	for slotIdx, item := range equipment.Items {
		slot := proto.ItemSlot(slotIdx)
		if item == nil || frozenSlots[slot] {
			continue
		}

		for gemIdx, gemID := range item.Gems {
			if gemID == 0 {
				continue
			}
			if frozenSockets[reforgeSocketKey{slot: slot, socketIdx: gemIdx}] {
				continue
			}
			if gem, ok := core.GetGemByID(gemID); ok && gem.Color == proto.GemColor_GemColorMeta {
				continue
			}
			if isHeadMetaSocket(item, slot, gemIdx) {
				continue
			}
			if gem, ok := core.GetGemByID(gemID); !ok || gem.Color != proto.GemColor_GemColorMeta {
				item.Gems[gemIdx] = 0
			}
		}
	}
}

func isHeadMetaSocket(item *proto.ItemSpec, slot proto.ItemSlot, gemIdx int) bool {
	if slot != proto.ItemSlot_ItemSlotHead {
		return false
	}
	if dbItem := core.GetItemByID(item.GetId()); dbItem != nil && gemIdx < len(dbItem.GemSockets) {
		return dbItem.GemSockets[gemIdx] == proto.GemColor_GemColorMeta
	}
	return gemIdx == 0
}
