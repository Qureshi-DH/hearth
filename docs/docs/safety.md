---
sidebar_position: 6
title: SOS and crash detection
---

Two separate things live under this heading.

**SOS** is deliberate. Somebody holds a button and their circle is told
immediately.

**Crash detection** is not deliberate, and it is the one worth reading
carefully. The phone watches for a collision while you are driving, asks if you
are all right, and if nobody answers it raises an SOS on your behalf.

Read the [limits](#limits) before you rely on any of this. Hearth does not
contact emergency services, and nothing in it is a certified crash sensor.

## Silence is what raises the alarm

This is the whole design, so it goes first.

When the phone thinks it has been in a collision it does not alert anybody. It
puts a full-screen prompt on the phone, sounds a loud notification, and waits
**30 seconds**.

- **"I'm okay"** dismisses it. Nothing is sent. Nobody is told anything.
- **"Alert my circle now"** raises the SOS immediately.
- **Doing nothing raises the SOS.**

That last line is not a bug and it is not a convenience. Somebody hurt badly
enough not to reach their phone is the exact case this feature exists for. A
detector that stayed quiet unless the injured person confirmed their own
injury would be useless. So the burden is the other way round: the alert is
already on its way, and answering is how you stop it.

The cost is that a forgotten phone in a footwell can alert a family over
nothing. That trade is made on purpose, and the detector's thresholds are set
conservatively to keep it rare.

## What the detector requires

The hard part is not spotting a violent jolt. Potholes, slammed doors and a
phone sliding off a seat all produce one. The hard part is refusing to shout
about them.

So the phone will only report a possible impact when the whole shape of the
event fits:

1. **The vehicle was moving beforehand.** Read from GPS speed when there is a
   current fix, and otherwise from the vibration of a car under way, which a
   parked car does not produce.
2. **There was a jolt far past anything the road produces.**
3. **The vehicle then stopped, and stayed stopped for several seconds.** Not
   "the phone went still". A phone lying on the floor of a car that is still
   driving is also still, but the vehicle's vibration keeps coming through the
   floor, and that is what gives it away.
4. **At least one further signal agreed.** Either the phone was spun hard, or
   cabin pressure rose sharply in the fraction of a second after the jolt,
   which is what an airbag inflating does to a closed car.

Points 1 and 3 are the same fact read twice, so they are treated as one. That
matters more than it sounds: without that rule, an ordinary stop at a red light
with something heavy shifting in the boot would clear the bar on its own.

The verdict is not reached at the moment of the jolt. The phone holds the
recording open for a few more seconds first, because whether the car carried on
driving is the strongest evidence available and it can only be read afterwards.

The corroborating signals also have to belong to the impact itself, not to the
same drive. A roundabout eight seconds earlier is a spin, and a hill is a
pressure change, and neither is allowed to vouch for a pothole.

## The gap this leaves

**A collision with neither rotation nor a pressure rise, on a phone with no
barometer, is not reported.**

That is written down here because it is a deliberate choice and not an
oversight. The alternative is to let the jolt corroborate itself, and a jolt on
its own cannot tell a crash from a phone hitting the footwell as the car pulls
up. Accepting that would turn every hard stop with a loose phone in the car into
an SOS, and a family that gets three false alarms stops believing the fourth.

The combination is uncommon: a phone loose in a crashing car almost always
tumbles, and most phones have a barometer. Uncommon is not never. This is a
detector that would rather miss than cry wolf, and you should hold it to that
description rather than to a better one.

## It asks for no permission

Crash detection reads the accelerometer, the gyroscope and the barometer. At the
rates Hearth samples them, neither iOS nor Android treats those as protected
sensors, so no permission dialog appears for any of it.

Running something like that unannounced would be the wrong thing to do, so the
app's permissions screen lists it anyway as an entry that is explicitly not a
permission, saying what it reads and what it will do.

**Nothing leaves the phone unless an incident escalates.** The sensor stream is
held in a rolling window in memory on the device. The verdict is reached on the
device. A detection is written to the phone's own storage and nowhere else, and
dismissing it deletes it. No accelerometer reading, no impact severity and no
record that a prompt appeared is ever uploaded. The first thing the server hears
about any of it is the SOS itself, if one is raised.

The detection is stored rather than kept in memory for one reason: the phone
that has just taken an impact is the one most likely to be restarted by it, and
an incident that only lived in RAM would be lost by exactly the crash it was
watching for.

## It is off unless a circle turns it on

One switch turns it on, and everything else follows from it.

**The circle setting.** An admin of the circle turns on "Possible-incident
alerts" in circle settings. It is **off by default** on every circle, including
new ones. Only admins can change it, over `PATCH /circles/:circleId`.

The phone mirrors one question locally: does any circle I belong to have this
on? If the answer is no, the sensors are never subscribed to.

Crash detection only runs while the operating system's own motion classifier
says you are in a vehicle. Parked or walking, none of it runs, which is both a
battery decision and an honesty one: a violent spike while somebody is walking
is a dropped phone, not a crash, and reading it as one would be guessing.

That classifier runs whenever location sharing does, because the location
side needs it to let the GPS sleep. Turning on incident alerts for a circle
does not have to start anything. It is asked for on the setup checklist as
Motion and Fitness on iOS, or activity recognition on Android. That is the
only permission anywhere in this feature, and it belongs to the vehicle
detection rather than to the crash sensing. A phone that refused it never
knows a drive has started, so crash detection cannot run there.

## What happens when it escalates

If the countdown runs out, the phone:

1. Takes a fresh highest-accuracy location fix and uploads it, so the alert
   carries where the person is now rather than where they were.
2. Raises a normal SOS in the currently selected circle, with the note
   "Possible collision detected automatically. No answer from the phone."

From there it is an ordinary SOS, described below.

The countdown is measured against the wall clock rather than counted down tick
by tick, because a phone is very likely to be locked or backgrounded after a
crash and a counter frozen at 14 would be the one failure this feature cannot
have. The escalation is still sent by the app itself, so it goes out when the
app is running: at the deadline if it is, and otherwise the moment the phone is
next picked up.

There are two time limits after that:

- **After five minutes**, escalation stops being automatic. The person may have
  walked away, been driven off, or the app may only now be coming back from a
  restart, and a location from a different quarter of an hour would send help to
  the wrong place. The prompt stays on screen and says so, and the "Alert my
  circle now" button still works.
- **After an hour**, the prompt is dropped without asking. A phone that comes
  back that long afterwards should not open on "Are you okay?" about something
  the person plainly walked away from.

One verdict per incident. After a possible impact is reported, further verdicts
are suppressed for a minute so a single crash does not report itself repeatedly.

## SOS

The manual version, and the thing crash detection escalates into.

**Sending one.** Hold the SOS button for three seconds. A plain tap is far too
easy to hit through a pocket. An optional note goes with it.

**What the server does.** In one transaction it forces your sharing state in
that circle to precise and cancels any pause, then creates the alert. An SOS
from somebody whose location is paused would be useless, so the emergency wins
over the privacy setting. Resolving the alert does not put the old setting
back, so somebody who was paused or approximate has to set it again. A second
SOS while one is already active is refused rather than duplicated.

**Who is told.** Every other member of that circle, at the highest priority the
transport allows, as "SOS from _name_" with your note as the body. This is the
one alert that ignores notification mutes: somebody who muted the circle last
Tuesday still gets it. On Android it arrives on a maximum-importance channel
that bypasses Do Not Disturb. On iOS it is marked time sensitive. Delivery
still depends on how you have set up [push
notifications](install/push-notifications.md).

**While it is open.** With the SOS screen up the phone takes a highest-accuracy
fix every 20 seconds on top of its normal cadence, so the circle sees movement
in near real time. A red banner sits on the circle's map for as long as the
alert is open, and tapping it jumps to that person.

**Ending it.** The person who raised it, or any admin of the circle, marks it
resolved. A resolution notice then goes to the circle, the person who raised it
included. Unlike the SOS itself, that notice respects notification mutes.

**Limits on it.** Three alerts per user per ten minutes, since an SOS bypasses
mutes and fires at top priority.

## The server-side check, which is a different thing

The same circle switch also turns on a second, much weaker check that runs on
the server against uploaded location fixes. It is worth knowing about, because
it produces a notification that looks similar and means something quite
different.

When it sees that somebody was driving at roughly 35 km/h or faster within the
last five minutes, their latest fix has them stopped, and nothing has moved for
three minutes, it tells the circle: "Check on _name_. They stopped suddenly
after driving at _N_ km/h and have not moved since."

Understand what that is. Fixes 30 seconds apart cannot tell a collision from
parking hard. It is a prompt to check on somebody, not a claim that anything
happened, and the wording in the app says so. It fires at most once an hour per
person, it never becomes an SOS on its own, and it does not ask the person
anything first. It only reaches circles that person shares precisely with, since
telling a circle they stopped hard somewhere is precise information about
somebody who may have chosen to be approximate.

The on-phone detector described above is the accurate one. This is the fallback
that works when the phone cannot sample for itself, and it runs whether or not
the on-phone detector does.

## Limits

Read this section as the specification, not as small print.

**The accelerometer saturates.** iOS caps third-party accelerometer readings
near 16 g, and a real collision goes well past that. Hearth can tell that
something violent happened. It cannot tell how bad it was. That is why every
name in the code and every string in the app says "possible", and why the app
asks the person instead of announcing a crash.

**This is not a certified crash sensor and must not be relied on as one.** It is
not connected to your vehicle. It does not read airbag deployment, seatbelt
tensioners or anything else the car knows. It is a phone in a cupholder making
an inference from three consumer sensors. Cars, phones with built-in crash
detection, and emergency call services are engineered and tested for this
job. Hearth is not, and no amount of care in the detector changes that.

**It calls nobody.** There is no emergency services integration anywhere in
Hearth, automatic or manual. An SOS notifies the people in your circle and does
nothing else. If somebody needs an ambulance, a person has to call for one.

**It only runs in a moving vehicle.** A crash on a bicycle or on foot, or one in
the first moments of a drive before the OS classifier has caught up, is not
seen. Neither is anything at all while the circle setting is off, which is the
default state.

**Escalation needs a working phone and a working connection.** A phone that is
destroyed, out of battery, or has no route to your server sends nothing. If the
call to the server fails, the app shows the error and leaves the prompt on
screen with the button, but it does not retry on its own. A self-hosted server
that is down is a server that cannot forward an SOS.

**It needs a selected circle.** If no circle is currently selected in the app,
the prompt clears without alerting anyone.

**It is tuned to miss rather than to shout.** Every threshold in it was chosen
so that ordinary driving stays silent, and each one of those choices is a case
where a real collision might go unreported. The documented gap above is the
clearest example, not the only one.

If you are setting this up for a young or vulnerable driver, tell them what it
does before they need it, and specifically tell them that not answering the
prompt is what sends the alert. Somebody who taps "I'm okay" out of reflex while
shaken has cancelled the thing you turned it on for.

See also [privacy](privacy.md) for what the server stores about location, and
the [FAQ](faq.md).
