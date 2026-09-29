//go:build with_db

package reforgeoptimizer

import (
	"testing"

	"github.com/wowsims/tbc/sim"
	"github.com/wowsims/tbc/sim/core"
	"github.com/wowsims/tbc/sim/core/proto"
)

// minimizeRegemsHarness builds a reforgeOptimizer wired for the minimizeRegems gem-swap tests:
// the original (pre-optimize) gems on originalEquipment, nothing frozen.
func minimizeRegemsHarness(original *proto.EquipmentSpec) *reforgeOptimizer {
	return &reforgeOptimizer{
		settings:          &proto.ReforgeSettings{},
		frozenSlots:       map[proto.ItemSlot]bool{},
		frozenSockets:     map[reforgeSocketKey]bool{},
		originalEquipment: equipmentFromProto(original),
	}
}

// clearGems strips every non-meta gem except the ones locked by frozen_gem_sockets.
func TestClearGemsKeepsFrozenSockets(t *testing.T) {
	sim.RegisterAll()

	const handsSlot = 6
	const smooth, bold = int32(24048), int32(24027)

	items := make([]*proto.ItemSpec, core.NumItemSlots)
	for i := range items {
		items[i] = &proto.ItemSpec{}
	}
	items[handsSlot] = &proto.ItemSpec{Id: 32278, Gems: []int32{smooth, bold}} // two Red sockets
	equipment := &proto.EquipmentSpec{Items: items}

	settings := &proto.ReforgeSettings{
		FrozenGemSockets: []*proto.GemSocket{{Slot: proto.ItemSlot(handsSlot), SocketIdx: 1}},
	}
	clearGems(equipment, settings)

	if got := equipment.Items[handsSlot].Gems; got[0] != 0 || got[1] != bold {
		t.Fatalf("clearGems = %v, want socket 0 stripped and frozen socket 1 keeping %d", got, bold)
	}
}

// minimizeRegems must never disturb a frozen socket, neither as swap source nor as swap target.
func TestMinimizeRegemsKeepsFrozenSockets(t *testing.T) {
	sim.RegisterAll()

	const wristSlot, handsSlot = 5, 6
	const smooth, bold = int32(24048), int32(24027)

	mkSpec := func(wristGem int32, handsGems []int32) *proto.EquipmentSpec {
		items := make([]*proto.ItemSpec, core.NumItemSlots)
		for i := range items {
			items[i] = &proto.ItemSpec{}
		}
		items[wristSlot] = &proto.ItemSpec{Id: 28174, Gems: []int32{wristGem}}
		items[handsSlot] = &proto.ItemSpec{Id: 32278, Gems: handsGems}
		return &proto.EquipmentSpec{Items: items}
	}

	original := mkSpec(bold, []int32{smooth, smooth})
	solved := mkSpec(smooth, []int32{bold, bold})
	newGear := equipmentFromProto(solved)

	optimizer := minimizeRegemsHarness(original)
	optimizer.frozenSockets[reforgeSocketKey{slot: handsSlot, socketIdx: 0}] = true
	optimizer.minimizeRegems(newGear)

	wrist := newGear.GetItemBySlot(proto.ItemSlot(wristSlot))
	hands := newGear.GetItemBySlot(proto.ItemSlot(handsSlot))
	if gemIDAt(wrist, 0) != smooth || gemIDAt(hands, 0) != bold || gemIDAt(hands, 1) != bold {
		t.Fatalf("frozen socket disturbed: wrist=[%d] hands=[%d %d], want wrist=[%d] hands=[%d %d]",
			gemIDAt(wrist, 0), gemIDAt(hands, 0), gemIDAt(hands, 1), smooth, bold, bold)
	}
}

func TestGemMatchesSocketSecondaryColors(t *testing.T) {
	testCases := []struct {
		name        string
		gemColor    proto.GemColor
		socketColor proto.GemColor
		want        bool
	}{
		{name: "orange matches red", gemColor: proto.GemColor_GemColorOrange, socketColor: proto.GemColor_GemColorRed, want: true},
		{name: "orange matches yellow", gemColor: proto.GemColor_GemColorOrange, socketColor: proto.GemColor_GemColorYellow, want: true},
		{name: "purple matches red", gemColor: proto.GemColor_GemColorPurple, socketColor: proto.GemColor_GemColorRed, want: true},
		{name: "purple matches blue", gemColor: proto.GemColor_GemColorPurple, socketColor: proto.GemColor_GemColorBlue, want: true},
		{name: "green matches yellow", gemColor: proto.GemColor_GemColorGreen, socketColor: proto.GemColor_GemColorYellow, want: true},
		{name: "green matches blue", gemColor: proto.GemColor_GemColorGreen, socketColor: proto.GemColor_GemColorBlue, want: true},
		{name: "orange does not match blue", gemColor: proto.GemColor_GemColorOrange, socketColor: proto.GemColor_GemColorBlue, want: false},
		{name: "red matches prismatic", gemColor: proto.GemColor_GemColorRed, socketColor: proto.GemColor_GemColorPrismatic, want: true},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := core.GemMatchesSocket(testCase.gemColor, testCase.socketColor); got != testCase.want {
				t.Fatalf("core.GemMatchesSocket(%s, %s) = %t, want %t", testCase.gemColor, testCase.socketColor, got, testCase.want)
			}
		})
	}
}

// minimizeRegems must never trade one socket bonus for a different one. Grips of Silent Justice
// (32278) have two Red sockets worth +4 Stamina; Shattrath Wraps (28174) have a single Red socket
// worth +3 Stamina. The solver put both Red gems on the hands to claim the bigger bonus and left
// the non-matching Yellow gem on the wrists. Undoing that cross-slot swap is socket-COLOR-match
// neutral — one Red socket stays matched either way — and leaves one bonus active either way, but
// it moves the claim from the +4 Stamina item to the +3 Stamina one, so it must be rejected.
func TestMinimizeRegemsKeepsLargerSocketBonus(t *testing.T) {
	sim.RegisterAll()

	const wristSlot, handsSlot = 5, 6
	const smooth, bold = int32(24048), int32(24027) // Yellow (no Red match), Red (Red match)

	mkSpec := func(wristGem int32, handsGems []int32) *proto.EquipmentSpec {
		items := make([]*proto.ItemSpec, core.NumItemSlots)
		for i := range items {
			items[i] = &proto.ItemSpec{}
		}
		items[wristSlot] = &proto.ItemSpec{Id: 28174, Gems: []int32{wristGem}}
		items[handsSlot] = &proto.ItemSpec{Id: 32278, Gems: handsGems}
		return &proto.EquipmentSpec{Items: items}
	}

	original := mkSpec(bold, []int32{smooth, smooth})
	solved := mkSpec(smooth, []int32{bold, bold})
	newGear := equipmentFromProto(solved)

	minimizeRegemsHarness(original).minimizeRegems(newGear)

	wrist := newGear.GetItemBySlot(proto.ItemSlot(wristSlot))
	hands := newGear.GetItemBySlot(proto.ItemSlot(handsSlot))
	if gemIDAt(wrist, 0) != smooth || gemIDAt(hands, 0) != bold || gemIDAt(hands, 1) != bold {
		t.Fatalf("socket bonus downgraded: wrist=[%d] hands=[%d %d], want wrist=[%d] hands=[%d %d]",
			gemIDAt(wrist, 0), gemIDAt(hands, 0), gemIDAt(hands, 1), smooth, bold, bold)
	}
}

// A socket bonus in a stat the player is already capped on is worth nothing, but the optimizer's
// caps live in the LP's constraints, not in its EP weights — so minimizeRegems cannot score the
// two arrangements by EP without happily trading a real Crit bonus for a dead Hit one.
// Vengeance Wrap (24259, +2 Hit) and Destroyer Greaves (30121, +2 Crit) each have a single Red
// socket, so the undo is socket-color-match neutral AND keeps one equally sized bonus active, yet
// it must still be rejected: the bonuses are not the same stat, so the swap is not provably free.
func TestMinimizeRegemsKeepsDifferentStatSocketBonus(t *testing.T) {
	sim.RegisterAll()

	const backSlot, legsSlot = 3, 8
	const smooth, bold = int32(24048), int32(24027) // Yellow (no Red match), Red (Red match)

	mkSpec := func(backGem, legsGem int32) *proto.EquipmentSpec {
		items := make([]*proto.ItemSpec, core.NumItemSlots)
		for i := range items {
			items[i] = &proto.ItemSpec{}
		}
		items[backSlot] = &proto.ItemSpec{Id: 24259, Gems: []int32{backGem}}
		items[legsSlot] = &proto.ItemSpec{Id: 30121, Gems: []int32{legsGem}}
		return &proto.EquipmentSpec{Items: items}
	}

	original := mkSpec(bold, smooth)
	solved := mkSpec(smooth, bold)
	newGear := equipmentFromProto(solved)

	minimizeRegemsHarness(original).minimizeRegems(newGear)

	back := newGear.GetItemBySlot(proto.ItemSlot(backSlot))
	legs := newGear.GetItemBySlot(proto.ItemSlot(legsSlot))
	if gemIDAt(back, 0) != smooth || gemIDAt(legs, 0) != bold {
		t.Fatalf("Crit bonus traded for a possibly capped Hit bonus: back=[%d] legs=[%d], want back=[%d] legs=[%d]",
			gemIDAt(back, 0), gemIDAt(legs, 0), smooth, bold)
	}
}
