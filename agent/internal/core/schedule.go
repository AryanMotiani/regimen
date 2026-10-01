package core

import (
	"math"
	"time"
)

// Local-clock helpers. Regimen reads the system clock and stores no time
// zone (docs/ARCHITECTURE.md, "Time and the clock"). All instants are epoch milliseconds.

func local(ms int64) time.Time { return time.UnixMilli(ms).In(time.Local) }

// IsoWeekday is 1 = Monday ... 7 = Sunday.
func IsoWeekday(ms int64) int {
	d := int(local(ms).Weekday())
	if d == 0 {
		return 7
	}
	return d
}

// StartOfDay is local midnight of the day containing ms.
func StartOfDay(ms int64) int64 {
	t := local(ms)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local).UnixMilli()
}

// AddDays adds calendar days while keeping the local wall-clock time (DST safe).
func AddDays(ms int64, n int) int64 {
	t := local(ms)
	return time.Date(t.Year(), t.Month(), t.Day()+n, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.Local).UnixMilli()
}

// AtMinutes is local midnight of dayMs plus minutes of wall-clock time.
func AtMinutes(dayMs int64, minutes int64) int64 {
	t := local(StartOfDay(dayMs))
	h := int64(math.Floor(float64(minutes) / 60))
	m := minutes % 60 // same sign rules as JavaScript's %
	return time.Date(t.Year(), t.Month(), t.Day(), int(h), int(m), 0, 0, time.Local).UnixMilli()
}

// Window is one instance of a weekly schedule, [Start, End) in epoch ms.
type Window struct {
	Start int64
	End   int64
}

func ruleMinutes(rule any, k string) int64 { return int64(Num(Get(rule, k))) }

func includesDay(rule any, day int) bool {
	for _, d := range Arr(Get(rule, "days")) {
		if StrictEq(d, float64(day)) {
			return true
		}
	}
	return false
}

// windowStartingOn returns the window instance that starts on the local day dayMs.
func windowStartingOn(rule any, dayMs int64) *Window {
	if !includesDay(rule, IsoWeekday(dayMs)) {
		return nil
	}
	start := AtMinutes(dayMs, ruleMinutes(rule, "start"))
	endDay := dayMs
	if !(Num(Get(rule, "end")) > Num(Get(rule, "start"))) {
		endDay = AddDays(StartOfDay(dayMs), 1)
	}
	end := AtMinutes(endDay, ruleMinutes(rule, "end"))
	return &Window{Start: start, End: end}
}

// WindowAt is the window containing now, or nil.
func WindowAt(rule any, now int64) *Window {
	today := StartOfDay(now)
	for _, day := range []int64{today, AddDays(today, -1)} {
		if w := windowStartingOn(rule, day); w != nil && now >= w.Start && now < w.End {
			return w
		}
	}
	return nil
}

// PreviousWindow is the most recent window whose end is <= now.
func PreviousWindow(rule any, now int64) *Window {
	today := StartOfDay(now)
	for i := 0; i <= 8; i++ {
		if w := windowStartingOn(rule, AddDays(today, -i)); w != nil && w.End <= now {
			return w
		}
	}
	return nil
}
