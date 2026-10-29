---
sidebar_position: 6
title: SOS and crash detection
---

Two separate things live under this heading.

**SOS** is deliberate. Somebody holds a button and their circle is told
immediately.

**Crash detection** is not deliberate, and it is the one worth reading
carefully. The phone watches for a collision while you are driving, asks if you
are all right, and if nobody answers it raises an SOS on your behalf. It runs
only on a drive, and only where a circle you are in has turned crash alerts on.

Read the [limits](#limits) before you rely on any of this. Hearth does not
contact emergency services, and nothing in it is a certified crash sensor.

## Silence is what raises the alarm

This is the whole design, so it goes first.

When the phone thinks it has been in a collision it does not alert anybody. It
asks, and waits **60 seconds**. With Hearth on screen the question is a
full-screen prompt. Otherwise, which after a crash is the usual case, it is a
loud notification on the lock screen that says what time the alert will go,
with an **I'm okay** button.

- **"I'm okay"** dismisses it. Nothing is sent. Nobody is told anything.
- **"Alert my circle now"** raises the SOS immediately.
- **Doing nothing raises the SOS.**

A crashed car does not drive on. If GPS has the car moving again at driving
speed a few seconds after the jolt, before the alert has gone, the question is
withdrawn and nobody is told.

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

1. **GPS had the vehicle at road speed just before it.** About 30 km/h or
   more, from a fix in the 15 seconds before the jolt, and the latest such fix
   counts, so a car that had slowed to a crawl had stopped. Vibration once stood
   in when GPS had no current fix. A phone handled in the hand after a drive
   shakes like a car under way, though, so a phone tossed onto a seat or a bed
   once the car was parked could read as a crash. Now GPS decides.
2. **There was a jolt far past anything the road produces.**
3. **The vehicle then stopped, and stayed stopped for several seconds.** Not
   "the phone went still". A phone lying on the floor of a car that is still
   driving is also still, but the vehicle's vibration keeps coming through the
   floor, and that is what gives it away. When no current GPS speed says the
   car stopped, its vibration has to drop to half of what it was before the
   jolt or less. A smooth motorway shakes a car less than a stopped one is
   allowed to, so a phone dropped in the footwell there would otherwise pass.
   And no fix after the jolt may have the car driving on.
4. **At least one further signal agreed.** Either the phone was spun hard, or
   cabin pressure rose sharply in the second or two after the jolt, which is
   what an airbag inflating does to a closed car.

Points 1 and 3 are the same fact read twice, so they are treated as one. That
matters more than it sounds: without that rule, an ordinary stop at a red light
with something heavy shifting in the boot would clear the bar on its own.

The verdict is not reached at the moment of the jolt. The phone holds the
recording open for a few more seconds first, because whether the car carried on
driving is the strongest evidence available and it can only be read afterwards.

The corroborating signals also have to belong to the impact itself, not to the
same drive. A roundabout eight seconds earlier is a spin, and a hill is a
pressure change, and neither is allowed to vouch for a pothole.

## The gaps this leaves

**A collision GPS cannot place at road speed is not reported.** One below about
30 km/h, or one in a tunnel or anywhere else GPS had no fix in the 15 seconds
before, says nothing to the detector. The alternative was letting vibration
vouch for the speed, and that is what alerted families over phones dropped in
parked cars.

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

## It asks for no permission of its own

Crash detection reads the accelerometer, the gyroscope and the barometer. At the
rates Hearth samples them, neither iOS nor Android treats the first two as
protected sensors. On iPhone the barometer falls under Motion and Fitness, which
the vehicle detection below already needs. So no permission dialog appears for
any of it beyond that one.

Running something like that unannounced would be the wrong thing to do, so the
app's permissions screen lists it anyway, while a circle has crash alerts on,
as an entry that is explicitly not a permission, saying what it reads and what
it will do.

It also reads the GPS for the length of the drive, since a speed the GPS
measured is the only one the detector believes. Those fixes stay on the phone.
None of them is uploaded, so the family sees you no more often for it. The
location indicator shows while the drive lasts, and never at home.

**Nothing leaves the phone unless an incident escalates.** The sensor stream is
held in a rolling window in memory on the device. The verdict is reached on the
device. A detection is written to the phone's own storage and nowhere else, and
dismissing it deletes it. No accelerometer reading, no impact severity and no
record that a prompt appeared is ever uploaded. The first thing the server hears
about any of it is the SOS itself, if one is raised. The phone's own tracker log
notes that an incident happened and how it ended, with no readings in it, and
that log only leaves the phone if you share it.

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

Crash detection only runs on a drive, which the operating system's own motion
classifier marks. Parked or walking, none of it runs, which is both a battery
decision and an honesty one. A violent spike while somebody is walking is a
dropped phone, not a crash, and a classifier that calls a parked phone a car is
no reason to start listening for one.

That classifier is asked for on the setup checklist as Motion and Fitness on
iOS, or physical activity on Android. Hearth needs it anyway, since it is what
lets a phone lying still answer the server without turning its location on.
It is the only permission anywhere in this feature, and on iPhone it also
covers the barometer. A phone that refused it never knows a drive has
started, so crash detection cannot run there.

On Android a drive begins the moment the classifier says you are in a
vehicle. The phone runs the GPS every five seconds and shows "Crash detection
is on for this drive" in the silent part of the shade. The drive ends when the
classifier says you are on foot, or still for three minutes with the GPS seeing
no speed in them, which a red light is not. It also ends after ten minutes of
the GPS having you standing, or when crash alerts or sharing are turned off. A
long standstill can end it while the classifier still says vehicle, and the
next ping that finds the car moving again starts it again.

An iPhone has no way to be woken for a drive. The drive begins at the first
ping from your server that finds iOS has the phone in a moving vehicle now, so
crash detection starts up to an interval into the
drive, and a short trip between two pings is never seen. From then the GPS
runs and iOS's own motion updates are read. The drive ends once iOS has had
you out of the vehicle for three minutes, at once when it is sure you are on
foot, after ten minutes standing, or when crash alerts or sharing are turned
off.

## What happens when it escalates

If the countdown runs out, the phone:

1. Takes a fresh highest-accuracy location fix and uploads it, so the alert
   carries where the person is now rather than where they were.
2. Raises an SOS in every circle you're in that has crash alerts turned on,
   with the note "Possible collision detected automatically. No answer from
   the phone." A circle that left crash alerts off is not told.

From there it is an ordinary SOS, described below.

**Nothing waits on a timer.** A locked phone does not run the app's timers, and
a phone is very likely to be locked after a crash. So the countdown is a time on
the wall clock, and the decision is taken at the next moment the app runs at
all. That is an upload, the operating system's periodic background task, the
notification's button, or the app coming to the front. The drive's own GPS
fixes stay on the phone and are not one of those moments, so with the screen
off the decision usually comes with the next ping's upload, which on a drive
is every couple of minutes. The detector's own verdict works differently. It
is reached by the next batch of sensor samples past its deadline, which the
native sampler keeps delivering with the screen off.

**"I'm okay" on the lock screen.** On Android the button answers without
opening the app. On an iPhone it opens Hearth and answers there, because iOS
only passes a button press to an app that is still running, and one that had
been closed would never hear the answer and would send the alert anyway.
Tapping the notification itself opens the prompt.

**No signal.** If the alert can't reach the server, the phone keeps it, and it
survives the app being closed or the phone restarting. The notification changes
to say it is waiting for a connection, and "I'm okay" still cancels it, since
nothing has gone out. It is tried again at most every 15 seconds, then 30
seconds, a minute, and every two minutes after that, and at once whenever the
phone manages to upload a location fix, because that proves the server can be
reached. A refusal from the server, such as an account that has been
deactivated, is not tried again. The app says so if it is open, and nothing
else happens.

There are two time limits.

- **After five minutes**, escalation stops being automatic. The person may have
  walked away, been driven off, or the app may only now be coming back from a
  restart, and a location from a different quarter of an hour would send help to
  the wrong place. The prompt and the notification say so, and the "Alert my
  circle now" button still works. This only applies to deciding. An alert the
  countdown already decided on before the five minutes were up keeps trying to
  get through.
- **After an hour**, the incident is dropped without asking, along with its
  notification. A phone that comes back that long afterwards should not open on
  "Are you okay?" about something the person plainly walked away from. That
  includes an alert that has been waiting an hour for a signal, which is
  dropped rather than sent that late.

The notification goes away when the incident ends, whether it was answered,
sent, refused or dropped.

One verdict per incident. After a possible impact is reported, further verdicts
are suppressed for a minute so a single crash does not report itself repeatedly.

## SOS

The manual version, and the thing crash detection escalates into.

**Sending one.** Hold the SOS button for three seconds. A plain tap is far too
easy to hit through a pocket. An optional note goes with it. The phone takes a
fresh highest-accuracy fix first and uploads it, so the alert carries where you
are now. It waits up to five seconds for that fix and then sends the alert
anyway. A phone indoors can take far longer, and the fix uploads when it comes.

**Where it goes.** To every circle you're in, not only the one on screen. One
emergency is one emergency, and the person who could help might be in any of
them. Somebody who shares two of those circles with you is told once.

**What the server does.** In one transaction it opens the alert in each of your
circles and forces your sharing state in each of them to precise, cancelling
any pause. An SOS from somebody whose location is paused would be useless, so
the emergency wins over the privacy setting. That includes a circle you had
paused or set to approximate on purpose. It sees your exact position while the
alert is open, and afterwards too, because resolving the alert does not put the
old setting back. Set it again yourself once you're safe.

Pressing again while an alert is open raises nothing new. The server answers
with the alert that is already open, so a press that seemed to fail on a weak
signal can be repeated without alerting anybody twice. The press does start
the alert's half hour on Live over again, as below.

**Who is told.** Every other member of those circles, once each, at the highest
priority the transport allows, as "🚨 SOS from _name_" with your note as the
body, or "Tap to see their location." without one. Notification mutes, quiet
hours and muting a person never apply to it, so somebody who muted the circle
last Tuesday, or who is asleep inside their quiet hours, still gets it. With
Expo push it arrives on Android on a maximum-importance channel that bypasses
Do Not Disturb, and on iOS it is marked time sensitive. Through ntfy it goes
out at ntfy's highest priority, and the ntfy app decides how to show it.

An SOS goes ahead of every other notification waiting to be sent. If the push
provider can't be reached, the server keeps trying, never more than three
minutes apart, until it gets through or the alert is resolved. One resolved
before it could be delivered is never sent late.

A closed app only hears about an SOS if the server has a push provider set up.
With `PUSH_PROVIDER=none`, the default, the server can only tell a phone over
its own connection to it, and the app rings for the alert itself when one
arrives that way. That connection is held only while Hearth is open. It
rings once per SOS, even one open in two circles you share, on the same SOS
channel, and never for your own. Any other phone hears nothing until Hearth is
opened, and then the alert shows as the red banner described below. The same
goes for a server set to push through a transport this phone can't receive,
such as a build with no push project in it.
[Push notifications](install/push-notifications.md) covers the options and what
each one needs.

**How loud it is.** On an iPhone an SOS is a Time Sensitive notification, not a
Critical Alert. Time Sensitive gets through any Focus that allows it, Do Not
Disturb included, and skips the scheduled summary, but it obeys the ring/silent
switch and the volume. A phone on silent shows it without a sound. Critical
Alerts, the kind that sound on a silenced phone, need an entitlement Apple
grants to an app on request, and Hearth does not have one, so it does not
pretend to. To make the most of what there is, keep Time Sensitive
Notifications on for Hearth under Settings, Notifications, Hearth, and in each
Focus you use, allow time sensitive notifications or add Hearth to the apps it
lets through. The ring/silent switch is the one thing that has to be left on
for it to make a sound.

On Android an SOS goes on Hearth's SOS channel, at the highest importance and
set to override Do Not Disturb. Android only lets an app's channel through Do
Not Disturb once the person has given that app Do Not Disturb access, so the
setup checklist has an optional step for it that opens the page where it's
granted. Hearth uses the access for the SOS channel and nothing else, which
carries an SOS, a possible crash and the server's "Check on" prompt. If you
changed the SOS channel's own settings by hand, Android keeps your choice, and
the switch to look for, usually called "Override Do Not Disturb", is on that
channel in Hearth's notification settings.

**While it is open.** For half an hour from when you raised the alert, or last
pressed SOS again, your phone is on Live, a fix a second, each one uploaded as
it comes, wherever the app is. The server
holds it there by naming a two minute window in the reply to every upload, and
asks the phone at once over its control channel when one is open. A family
member's own Live watch is left as it was. Turn a circle back down to
approximate or paused, or leave it, and that circle no longer holds the phone
on Live. Once no circle with an open alert sees you precisely, the phone steps
down. After the half hour the phone goes back to answering the ping. The
family can still open Live on it as on anybody, and pressing SOS again puts it
back on Live for another half hour. Before 1.3.4 an alert nobody
resolved, which is what a false crash alarm tended to leave behind, held the
phone at a fix a second for days.

A phone whose tracker can't run in the background, because it only has
location permission while the app is in use, gets a fix every 20 seconds from
the SOS screen instead, and only while that screen is open. Once the half
hour is up, the SOS screen does the same for any phone that is not on Live.
With _Share my location_ switched off no fix leaves the phone, not even the
alert's own. The
alert still goes out, the SOS screen says so, and your circles see where you
were last.

A red banner sits on the map of every circle the alert is open in, and tapping
it jumps to that person.

**Ending it.** The person who raised it marks it resolved, which closes it in
every circle at once. Any admin of a circle can close it in that circle, and
only there. Each circle gets its own entry in its feed, and a resolution notice
goes to everyone in it, the person who raised it included. Somebody in several
of those circles gets one notice. Like the SOS itself, that notice ignores
notification mutes. The phone leaves Live at its next upload after the alert
is resolved, unless somebody still has its Live page open, or within two
minutes if its uploads stop getting through.

**Limits on it.** Five fresh alerts per person per ten minutes, since an SOS
bypasses mutes and fires at top priority. Pressing again on an alert that is
already open doesn't count, so the limit only meets somebody who has raised and
resolved five in a row. The route itself takes 60 requests per account per ten
minutes.

## The server-side check, which is a different thing

The same circle switch also turns on a second, much weaker check that runs on
the server against uploaded location fixes. It is worth knowing about, because
it produces a notification that looks similar and means something quite
different.

It looks for four things together.

- Somebody was driving at roughly 35 km/h or faster.
- The very next fix after their cruising speed had them stopped, no more than
  40 seconds later. When every fix after the stop is too rough to place a
  street, as in a tunnel, the next fix may take two minutes. A car that slowed
  down first, like one pulling onto a petrol station forecourt, shows that in
  a fix of its own and doesn't count. On Live, where the phone sends a fix a
  second, the slowing down itself is in the fixes, so there the car has to
  shed its cruising speed faster than firm braking does, at 4.5 m/s² or more
  on average.
- Nothing has moved for five minutes since.
- The stop isn't at one of the circle's places, or within 40 metres of its
  edge. Each circle goes by its own places, so a stop at Gran's still reaches
  a circle that has no place there. Only the first 200 metres of a place's
  radius count, so a place drawn round a whole town doesn't hide a stop on the
  bypass through it.

The phone has to send the stop within seconds of the cruising speed for any
of this to work, and since 1.3.4 a phone does that only on Live. Outside Live
it answers a ping every couple of minutes, and the GPS fixes crash detection
takes on a drive stay on the phone, so the check has nothing close enough
together to read. In practice it covers a drive somebody is watching. The
detector on the phone itself doesn't depend on any of this.

When all four hold, the circle is told "Check on _name_. They stopped suddenly
after driving at _N_ km/h and have not moved since."

Understand what that is. Even a fix a second cannot tell a collision from
braking hard and parking. It is a prompt to check on somebody, not a claim
that anything happened, and the wording in the app says so. It fires at most once an hour per
person, it never becomes an SOS on its own, and it does not ask the person
anything first. It is sent on the same notification channel as an SOS, goes
ahead of other notifications the same way, and is retried through a push
outage for up to an hour, unless they have since driven on or stopped sharing
precisely with that circle. Notification mutes don't silence it. It only
reaches circles that person shares precisely with, since telling a circle they
stopped hard somewhere is precise information about somebody who may have
chosen to be approximate.

The on-phone detector described above is the accurate one. This is the
fallback that works when somebody is watching on Live, and it runs whether or
not the on-phone detector does.

On a server with no push provider, a phone that hears this check over its own
connection rings for it the way it rings for an SOS, as [SOS](#sos) describes.

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

**It only runs in a moving vehicle.** A crash on a bicycle or on foot, or one
in the first moments of a drive before the OS classifier has caught up, is not
seen. On an iPhone it starts only once a ping from your server finds the
drive, so up to an interval into it, and a short trip between two pings is
not seen at all. A phone that refused Motion and Fitness, or physical
activity, never runs it. Neither is anything at all seen while the circle
setting is off, which is the default state.

**Escalation needs a working phone and a working connection.** A phone that is
destroyed, out of battery, or has no route to your server sends nothing. With
no signal the alert waits on the phone and goes as soon as the server can be
reached, but only for an hour after the incident, and a phone that is switched
off or has been force-stopped is not running to send it. A self-hosted server
that is down is a server that cannot forward an SOS. And one with no push
provider can only ring on phones that are still connected to it, as
[SOS](#sos) explains.

**It needs a circle with crash alerts on.** The alert goes to the circles that
turned them on. If none of your circles has them on any more by the time it is
sent, it is dropped without alerting anyone.

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
