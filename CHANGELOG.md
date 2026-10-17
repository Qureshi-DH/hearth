# Changelog

Notable changes to Hearth. The format is loosely
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-10-18

Phones that keep sharing and say why when they can't, two notifications for a
journey instead of three, Live for anyone you see precisely with the whole
trail, SOS and crash alerts that hold up, and Hearth at a path on a domain you
already use. Update the server first. Migrations 0012 to 0014 run on start.
Older phones keep working against it, and the app shows the new controls only
on a server that has them.

### Added

- More say over what you hear. Each circle's notification settings let you
  choose, for each of its places, arrivals, departures, both or neither, and
  stop hearing about one person's comings and goings, which covers their
  arrivals, departures and trips wherever you share a circle. Quiet hours
  hold ordinary news until they end, or drop it, on your phone's own clock and
  across every circle. SOS, possible crashes and the notice that an SOS was
  resolved ignore all of it. Muting a person and quiet hours are stored on
  your account, so every phone you sign in on agrees. The server adds
  `PATCH /me/notifications`, `places` on `PATCH /circles/:id/notifications`,
  `timeZone` and `clock` on `POST /push/register`, which the app sends on
  every launch, `notificationSettings` on the account, and
  `features.notificationControls` in `server-info`. The app shows the new
  controls only on a server that has them.
- Hearth can sit at a path on a domain that already has something at its root,
  such as `https://lab.example.com/hearth`. Put the path in `PUBLIC_URL`. A
  proxy that strips the path and one that passes it on both work. The admin
  portal, its sign-in cookie, the websocket, invite links and the API docs all
  follow the path, and phones take the full address with the path in it. The
  server refuses a path Hearth already uses, such as `/join` or `/docs`. A path
  shares its domain's origin with the app at the root, which can then act as
  you in the admin portal, so the docs suggest a subdomain unless you trust
  that app as much as Hearth.
- A choice of map styles, picked per phone under You, Appearance, Map style,
  with a preview. On the default OpenFreeMap tiles that is Liberty, Bright or
  Positron in light mode and Dark or Fiord in dark mode. `MAP_STYLES` sets
  your own list as JSON. A server whose `MAP_STYLE_URL` or
  `MAP_STYLE_URL_DARK` is set to anything but the default keeps offering just
  those two.
  Server-info gains `mapStyles`, and older apps keep using `mapStyleUrl` and
  `mapStyleUrlDark`, which stay the defaults.
- Every password field in the app, sign-in included, has a button that shows
  what you typed.
- Your own map says when _Share my location_ is off, with a button that turns
  it back on, and your circles are told as well. A circle that allows pausing
  sees it as a pause. One with pausing turned off sees "Turned off location
  sharing" under your name, keeps your last position, and its offline alert
  says that is why rather than that the phone stopped reporting. A fix newer
  than the report reads as sharing back on.
- The family is told when a phone's precise location or its motion access is
  off. Neither stops a phone reporting, so nothing said so, and rough
  positions or a GPS that never sleeps looked like a broken phone. Precise
  location off shows on the member's page while the fixes are fresh, and both
  show under the name once the phone goes quiet, as they do in the admin
  portal. Health reports gain `preciseLocation`, `motionPermission` and
  `sharingEnabled`, and an older server ignores them.
- On Android the setup checklist has an optional step that gives Hearth Do
  Not Disturb access. The SOS channel always asked to override Do Not
  Disturb, and Android ignores that for an app without the access, so an SOS
  or a possible-crash alert stayed quiet in it. Hearth uses the access for
  those alerts and nothing else, and puts the SOS channel through again once
  it is granted. The app now declares `ACCESS_NOTIFICATION_POLICY`.
- On a server with no push provider, the app rings for somebody else's SOS or
  possible crash when it hears one over its own connection to the server.
  That is while Hearth is open, on an iPhone while it shares its location,
  and on an Android phone while it is on the move. It rings once per SOS,
  even one opened in two circles you share, on the SOS channel and never for
  your own. It takes the notification down again only if it is still
  connected when the SOS is resolved. The setup checklist and notification
  settings say what such a server can and cannot do.
- When the family was sent "phone offline", they now hear when it is
  reporting again. Through Expo the line joins the notification that said it
  went quiet. Only people the alert actually reached get it, and muting
  "Phone offline" silences both. It goes on the alerts channel.
- Through Expo, the server reads each send's receipt about half an hour later
  and clears the token of a phone the app was uninstalled from, so nothing
  more is sent to it until the app registers again. Tickets are kept in the
  new `push_tickets` table, read a thousand at a time every quarter hour, and
  dropped after a day.

- Live lets go of the phone when you leave. Each viewer holds the watch on
  their own, and once the last one closes the page or puts Hearth in the
  background, the phone hears it in its next upload reply and over its own
  line to the server and steps down within seconds. It stayed on a fix a
  second for up to ten minutes. Turning a circle to approximate or pausing it
  ends that circle's watches at once, leaving the circle ends the ones you
  held or were the subject of, and an open SOS still keeps the phone on Live.
  The server adds `DELETE /circles/:id/members/:userId/watch` and the
  `live_watches` table, and the watch reply gains `supports`. The app sends no
  release to a server whose reply leaves it out.
- A Live trail is every fix the phone sent rather than one per upload, and
  the gap a dropped connection or a trip to the background leaves is filled
  in when the page comes back. Location frames to a viewer who sees the member
  precisely carry the upload's `fixes`, and
  `GET /circles/:id/members/:userId/live-trail` hands back the fixes since a
  given moment, from the device the map follows and no further back than the
  ten minute window, whether or not the circle keeps history.
- The map and the Live page say "Reconnecting…" once their connection to the
  server has been down for five seconds, so dots that stop moving read as the
  connection and not as the people.
- Invite links and their QR codes carry the server's address. The page an
  invite opens has an Open in Hearth button that fills in the server and the
  code on a phone that was never set up, and steps for somebody without the
  app, which link to `IOS_APP_URL` and `ANDROID_APP_URL` when set. It no longer
  opens the app by itself, which on a phone without it put an error in front
  of the steps. The button is `hearth://join/<code>?server=<address>` and the
  QR is the invite's `url`, so older apps still find the code in both. A code
  that isn't found says which server it belongs to.
- The data export includes your SOS alerts, the devices signed in to your
  account with the address and browser each used, and the feed entries you
  made or that are about you. They name circles and people rather than ids.
  `GET /me/export` gains `sosAlerts`, `devices` and `activityFeed`.

### Changed

- A journey between two named places is at most two notifications. "Aisha
  left Home" goes once a second fix is outside too, or a minute passes with no
  fix back inside, so a Wi-Fi fix that jumps down the street no longer sends
  "left Home" and then "arrived at Home". "Aisha arrived at School, 4.2 km
  from Home in 14 min" carries the journey, worked out from the fixes since
  she left. When the phone's next word after leaving is already from
  somewhere named, only the arrival is sent. A trip that ends at a named place
  goes to the feed only, and one that ends anywhere else sends "Aisha stopped
  4.2 km from Home". Older apps show these words as they come.
- An arrival goes as soon as the server sees it, rather than two minutes
  later and then on the next minute's tick. Only a phone doing 18 km/h or more
  waits, up to a minute, in case the car is driving past. Anything held back
  for a moment, or waiting for a retry, now goes the moment it falls due.
- News that arrives more than a couple of minutes late says when it happened,
  "Aisha arrived at School at 8:31", on the reader's own clock, or how long ago
  where the phone never said its time zone. Distances follow the reader's
  units. Arrivals, departures and trips are all pushed up to half an hour
  late and no later, where trips went on for an hour.
- Every visible notification plays the sound on an iPhone, as it already did
  on Android, since each update to a card is a new line of news.
- One SOS press alerts every circle you're in, not only the one on screen, and
  somebody who shares two of those circles with you hears about it once. It
  switches you back to precise in each of them, paused and approximate ones
  included. A crash alert nobody answered goes only to the circles that have
  crash alerts on. Resolving it yourself closes it everywhere, with an entry
  in each circle's feed and one notice per person, and an admin still closes
  it only in their own circle. `POST /circles/:id/sos` takes `reason`, `sos`
  or `incident`, and its reply gains `alerts`, one per circle. With
  `incident` the server raises it in every circle of the caller with crash
  alerts on and in the circle the request names, and the app always names one
  that has them on. An older app sends no reason, so its crash alert is
  recognised by the note its prompt puts on it, and anything else it sends is
  a press that reaches every circle.
- While your SOS is open your phone is on Live, a fix a second wherever the
  app is, until you resolve it. It used to report
  every 20 seconds, and only while the SOS screen was open. The SOS screen
  uploads a fresh fix before it sends the alert, waiting up to five seconds
  for one, and says so when _Share my location_ is off on the phone, since
  then your circles only see where you were last. The upload reply's
  `watchedUntil` is set while the uploader has an SOS open, without touching
  the window a viewer's watch holds.
- The Activity tab shows the shape of the feed while it loads, rather than
  nothing, and says so when the feed couldn't load, with a button to try
  again. "All quiet" now only appears once the server has answered with no
  events.
- A parked phone's dot stays fresh for 35 minutes rather than 15. It reports
  every quarter of an hour, so the stale line sat on the beat itself and a
  healthy phone at home faded in and out on the map. A phone gone quiet now
  says "Not updated recently" before it says where it last was, so a phone
  that died at home no longer reads as "At Home since two".
- The phone sends its health report from the background as well as when the
  app opens. It goes when the location service dies, when Play Services drops
  the geofence, and when the sync task or a parked iPhone's quarter hour timer
  finds the permission or Location switched off, at most once in ten minutes.
  It also goes for each account that signs in on the phone, where a second
  account that said the same as the first within a day was never heard.
- While somebody watches Live, the tracker log gets one line every half minute
  rather than three for every fix, and each line is written on its own rather
  than rewriting all thousand. A Live window used to push the night's evidence
  out of the log within minutes.
- A crash alert nobody answered goes through a circle that has crash alerts
  on, rather than through whichever circle was on screen, and a phone with no
  circle selected no longer drops it. When nothing has loaded the circles,
  the app asks the server for them. The app sends `reason: "incident"`.
- A parked Android phone is called offline once it has let the server's three
  wakes go unanswered, about 100 minutes after it was last heard, rather than
  after twelve hours. It reports every quarter of an hour and Android
  delivers a wake even from Doze, so by then it is not coming back by itself.
  A parked iPhone keeps the twelve hours, because iOS holds silent pushes
  back, and so does an account signed in on an iPhone and an Android phone.
  The admin portal shows the phone as stopped reporting at the same moment.
- A phone that went quiet on 5% battery or less is reported as "Battery
  likely ran out" rather than as power saving being on, which a nearly flat
  phone turns on by itself. A switch the phone said was off, such as the
  location permission, is still named first.
- "Ask for location" says what became of it rather than that it worked. It
  says their phone is updating now, or has been asked, or reported a moment
  ago, or that no phone of theirs can be woken from here, that you asked a
  moment ago, that they paused sharing, or that they are no longer in the
  circle. For somebody sharing precisely the ask wakes their phone for a fix
  as well, the same way opening their page does, since the alert on its own
  moves only an app that gets to run. The nudge reply gains `notified` and
  `asked` beside `ok: true`, and the same words to the same person within a
  minute are sent once. A nudge to somebody who has left answers
  `notified: "gone"` where it was a 404.
- Quick messages reach somebody who has paused sharing, since a message says
  nothing about where they are. A bare ask for their location is not sent and
  answers 200 with `notified: "paused"`, where a 403 used to refuse it.
- The app keeps every phone to six nudges and quick messages in ten minutes,
  and says how long to wait rather than send one the server would refuse.
  The server takes ten per account, up from six.

- Live is offered for anyone you see precisely, parked or on the move, and
  never on your own page. It was offered only while somebody was travelling,
  though a parked phone goes live too and the page says when a phone doesn't
  answer.
- Speed alert choices follow your units, in mph for miles. They're still
  stored in km/h.

### Fixed

- A trip could be sent before the arrival it ended in, naming a place the
  fence had not yet said they reached. A trip now takes its ends from the
  fence's own records, so the two can't disagree.
- A drive-past whose leave fix uploaded after the held arrival went out
  stayed as "arrived at School". The leave is now sent unless it really
  cancelled the arrival.
- Places inside places picked whichever came first. Every reader now takes the
  smallest place containing the spot, then the nearest centre, so an arrival,
  a trip and a check-in agree, a trip no longer reads "from Town to Town", and
  walking into a Home inside a Town is one arrival.
- Sharing precisely again after approximate or a pause announced a departure
  from hours before as if it had just happened. The circle's places now start
  from where you are, without a word.
- Somebody pacing a boundary sent a pair of notifications for every lap. A
  return within ten minutes now keeps that place to the feed for a quarter of
  an hour after it.
- The "Sharing paused" switch did nothing, because pausing sent no
  notification. The circle is now told, "Aisha paused location sharing for 1
  hour", unless they turned the switch off.
- Pressing SOS again after a reply was lost on a weak signal got a 409, and a
  fourth press inside ten minutes a 429, which a firewall in front of the
  server can answer by cutting off every phone in the house. A press on an
  alert that is already open now answers 200 with that alert and sends nothing
  twice. 201 means something new was raised. The limit counts fresh alarms,
  five per person in ten minutes, and the route takes 60 requests per account
  in that time.
- Tracking starts again on its own once it can. After a session expired and
  you signed back in, after a change of server, or after you fixed the
  location permission in Settings, the switch stayed on and the phone shared
  nothing until Hearth was closed and opened again. It now starts on sign-in
  and whenever the app comes to the front, and never while you have sharing
  turned off.
- An Android phone set to Approximate location, or an iPhone with Precise
  Location off, could never park. Neither OS arms a geofence for it, so the
  tracker kept the moving tier all day, with the location notification up and
  the dot flipping between still and moving. It now parks without the fence,
  and the resting request and the motion classifier notice it leave.
- A loose network fix no longer ends a stop on its own. A 200 m Wi-Fi
  estimate 400 m off counted as the phone leaving. A fix looser than 100 m is
  now a reason to take a sharper one and go by that.
- An Android phone that set off while Android refused its location service
  had no location request at all until the next moment Android allowed the
  start. It now keeps one running, which Android throttles but still answers,
  until the service can start.
- Android driving trails keep every fix at 50, 70 and 100 km/h. The distance
  gate rounded up past what the car covers in ten seconds, so every other fix
  was dropped and the trail cut the corners.
- A parked phone's quarter hour report is sent from where it parked, with the
  arrival fix's accuracy. A parked iPhone sent its cell-only estimate dated
  now, which could put somebody at home hundreds of metres to a kilometre
  away. A fix sharp enough to say the phone left still ends the stop.
- A geofence Play Services dropped is added back. It drops every fence when
  Location is switched off, and the app's own record still said armed, so the
  sync task never re-armed it and the hourly check was all that noticed a
  departure.
- After Hearth refuses a batch of fixes, the phone waits before sending the
  next rather than sending the rest of its queue straight after it, each one a
  failed request to a firewall that locks out an address for it. A 403 from
  Hearth stops sharing and says why on the You screen.
- Walking out of the house is noticed within minutes rather than at the
  geofence. The one fix that confirms a walk comes half a minute in, still
  inside the fence, and nothing looked again. A second look now comes about
  three minutes later, wherever the process is still running, which on
  Android is up to Android.
- A car parked with somebody still in it no longer has its GPS come back every
  few minutes. Core Motion keeps calling a stopped car automotive, and every
  sample of it un-parked the phone. A sample that only repeats the verdict the
  phone parked on now needs a fix to agree.
- Live stays live when the Android phone you're watching is standing still or
  stops. A parked phone used to answer with one fix, and one that parked while
  watched dropped back to its resting report, so the page showed a speed and
  went grey half a minute later. It now sends a fix a second for the whole
  window, parked or moving, with the location notification up until the window
  ends. If Android won't start the service, it answers with one fix as before
  and keeps its quarter-hourly report.
- The "Signed out of Hearth" notification could arrive as
  `session:signedOutTitle` and `session:signedOutBody`. When Android starts
  Hearth in the background for the tracker, the app's screens never load, and
  they were the only thing that set up the app's text. It now sets itself up
  the first time anything asks for a string.
- The app's Signed-in devices screen could stay blank. It drew nothing while
  the list loaded and nothing at all when the list failed to load, say because a
  firewall in front of the server refused the request. It now shows the list
  loading, says why it couldn't load with a button to try again, and says so
  when the server lists no devices.
- A phone no longer signs itself out when something in front of the server,
  such as a firewall or a proxy, answers a token renewal with its own 401 or
  403 page. Only Hearth's own refusal ends the session now. Anything else is
  retried, as a network failure is. The admin portal does the same, and a phone
  keeps the location fixes such a page refused rather than throwing them away.
- Pulling the Activity tab down to refresh with no circle loaded asked the
  server for the feed of a circle called `null`. It now loads the circles
  again.
- A crash alert on a phone with no signal is no longer lost. It was tried
  once, the moment the countdown ran out, and a failed call was never tried
  again. The alert now waits on the phone, survives a restart, and goes as
  soon as the server can be reached, at once after any location upload that
  gets through. "I'm okay" cancels it until then, and after an hour it is
  dropped.
- A crash on a locked phone now escalates. The countdown and the detector's
  verdict ran on the app's timers, which stand still while the phone is
  locked. Both are decided on the wall clock at the next moment the app runs,
  which on a drive is the next location fix or batch of sensor samples. While
  Hearth isn't in front, a notification says what time the alert will go and
  has an I'm okay button, which on Android answers without opening the app.
  The notification goes when the incident does, however it ends.
- The "Are you okay?" alarm was posted on an ordinary notification channel,
  because the channel was set where expo-notifications ignores it, so Do Not
  Disturb silenced it. It goes on the SOS channel now.
- "Phone offline" could arrive after the phone was back. An alert held up by
  a push provider outage is now dropped if the phone has reported since it
  was queued.
- A home server whose own internet connection went down told a small family
  that every phone had died, because the outage guard needed eight phones
  before it did anything. Offline alerts now wait while the server can't
  reach the push provider, and on a server with fewer than eight phones while
  two or more not yet announced count and not one is reporting. Once they
  have waited for an outage they keep waiting for half an hour after, through
  a restart, so the other phones can get back through after the first. A
  wake that never reached the push provider no longer counts as asking the
  phone. A server with a single phone still says when it goes quiet.
- An SOS stopped being retried after six tries, about 80 minutes, when the
  push provider was down. It is now retried every few minutes, never more
  than three apart, until it is delivered, resolved or deleted with the
  account that raised it. A possible crash alert is retried the same way for
  up to an hour, and dropped sooner if the person has since driven on or
  stopped sharing precisely with that circle. A provider that refuses the
  message itself with a 4xx still gets only the six tries.
- An SOS or a possible crash waited its turn behind every ordinary
  notification queued before it, since nearly everything goes out at high
  priority. They now go first. Ordinary news keeps its high priority.
- "Ask for location" didn't get a fix from a parked iPhone until somebody
  opened Hearth on it. Through Expo the request is now marked
  content-available on iOS, at the priority iOS allows for a push that shows
  an alert, so the app takes a fix in the background as it does for a wake.
  iOS still decides when to run it.
- A quiet phone whose last reading was 5% or less, off the charger, read "Low
  Power Mode is on" under its name, and "Power saving mode is on" in the admin
  portal, when a dying phone turns that on by itself. Both now say the battery
  likely ran out, and a switch somebody turned off is still named first.
  Presence leaves power saving, battery optimisation and a restricted or
  stopped service out of `issues` for such a phone, so an older app says it
  went quiet instead. The admin overview's phones gain `batteryRanOut`.
- An Expo send answered `InvalidCredentials` cleared the phone's push token,
  though the fault is in the Expo project's FCM or APNs keys, so one expired
  key unregistered every phone on the server. Only `DeviceNotRegistered`, and a
  Web Push 404 or 410, clears a token now. A credentials refusal counts as a
  failed send, is retried, and is logged as an error, from a receipt too.
- Pruning week-old rows from the push queue deleted them all in one
  statement. It now goes in batches of 5 000, at most 20 a pass, like the
  other prunes.
- A check-in made while a circle saw you approximately, or not at all, became
  exact for that circle once you went back to precise. It now keeps the
  precision it was made with, which is what the privacy page always said.
  Turning sharing down still takes older check-ins down with it. Check-ins
  record `shared_as`, and ones from before keep answering to your sharing now.
- Opening the page of somebody sharing approximately or paused, or in a circle
  with history off, asked for their trips and got a 403, which a firewall in
  front of the server can answer by cutting off every phone in the house. The
  page no longer asks, and the trips and history routes answer an empty list
  in those cases, and for somebody who has left the circle.
- A trip opened from a list that had gone out of date, because their sharing
  changed or a late backlog folded the trip into its neighbour, was a blank
  page and a 403 or 404. It now says the trip is no longer available. The app
  sends `soft=true` to `GET /trips/:tripId`, which then answers
  `{ id, visible: false }`. Without it the old answers stay, for older apps.
- More requests the app makes in ordinary use no longer get a 4xx. A face
  whose picture was just replaced loads one transparent pixel instead of a
  404 page. Editing or deleting a place somebody else just deleted says so, and
  the editor offers nothing to save. A member's page opened again for
  somebody who just left answers that they cannot be asked. The map and a
  member's page can be revisited as often as anyone likes, at 120 and 180
  asks per ten minutes. Somebody removed from a circle is told an old invite
  can't bring them back before they press Join. A plain admin is no longer
  offered removing another admin, which only the owner can do. A geocoded
  name too long for a place is cut to fit, and a code carried in by a link is
  cleaned the way a typed one is.
- In the admin portal, opening it signed out, or after the session ended, got
  a 401 every time, and other tabs each got one more after signing out in one.
  The refresh route answers `{ signedIn: false }`, and a tab that signs out
  tells the others. The dashboard draws a time zone the database doesn't know
  in UTC rather than being refused every minute, signing out a device that
  already signed out answers that it did, "Send me a test" says to wait before
  the server would refuse it, and the account search stops at the 120
  characters the server reads.
- A wrong password when deleting your account is answered with
  `wrong_password`, as the other password checks are, rather than as a
  session that ran out.
- After somebody removed you from a circle, or deleted it, the app went on
  asking the server about it every half minute while it stayed open, and was
  refused each time. The server now tells your open app at once, and the app
  drops the circle, moves the map to another and stops asking. A refusal for
  a circle the app missed hearing about makes it check its circles once. The
  socket's `subscribed` is sent again whenever the circles it carries change,
  deletion included.
- Leaving a circle no longer asks for its members on the way out.
- A wrong password, or a 401 page from something in front of the server, is
  no longer renewed and sent again, which made one wrong password two
  refusals. The app retries no 4xx at all, where a 409 or 429 used to go
  twice more.
- Exporting your data and sending a test notification say how long to wait
  before the server would refuse another, and the map asks for its quiet
  phones' fixes at most once in half a minute per circle.
- The admin screen in the app no longer offers deactivating your own account
  or removing your own admin, which the server refuses.
- The "Signed out of Hearth" notice goes on the alerts channel on Android. It
  named the channel where Android doesn't read it, and landed on the default.
- A phone dropped into the footwell on a smooth motorway could read as a
  crash. A smooth road shakes the car less than a stopped one is allowed to,
  so the phone lying on the mat passed for a car that had stopped, and its
  tumble on the way down was the second signal. With no current GPS speed to
  say the car stopped, the vibration after the jolt now has to drop to half of
  what it was before or less.
- "Check on _name_" no longer goes out for an ordinary stop, like three and a
  half minutes at a petrol pump after a 45 km/h approach. It comes on the SOS
  channel and through mutes, so a false one costs a lot. The car now has to go
  from cruising speed to stopped between one fix and the next, at most 40
  seconds apart, or two minutes when only rough fixes follow, as in a tunnel.
  On Live it has to shed its speed faster than firm braking does. It has to
  stay put for five minutes rather than three, and not be at one of the
  circle's places or within 40 metres of it. Each circle goes by its own
  places, and only the first 200 metres of a place's radius count.
- A phone in a car sends the first fix after it comes off road speed straight
  away, whatever its distance gate says. It held back every fix of a car
  standing still for five minutes, so after a crash the server's first word
  was the park fix and "Check on _name_" could not call the stop sudden. A
  phone on 1.2.0 or earlier still holds that fix back, so the server's check
  rarely fires for it. The crash detector on the phone is not affected.
- A speed alert no longer fires on two GPS spikes in a row. On Live, with a
  fix a second, two spiking fixes are one second of driving, and a 58 km/h
  drive was announced at 133 km/h. The speed now has to stay over the limit
  for 15 seconds of the drive, however few fixes carry it, so a phone that
  reports once a minute on the motorway still raises one. The speed quoted,
  and the trip card's top speed with it, is never faster than the ground
  between two sharp fixes allows.
- A parked Android phone whose live service Android stopped in the middle of
  a watch wasn't asked again for up to ten minutes, because answering once
  counted for the whole window. The server pushes again once the phone has
  said nothing for 20 seconds and the last push is 90 seconds old.
- A killed or suspended iPhone lost the first minute of Live. Its line to the
  server looked open for minutes after iOS stopped the app, so the ask went
  nowhere and the push waited for the next hold. An ask down that line is now
  believed only when the phone says it has it, and without that answer within
  three seconds the push goes at once. Opening a member's page works the same
  way. A watch push waits five minutes for the phone rather than one. Control
  frames carry an `ask` id and the app answers `{ type: "control", ack }`,
  which an older server reads as the line's declaration again.
- One stuck upload froze Live for up to half a minute. On Live an upload gets
  four seconds and then goes again at once on a fresh request, with the same
  fixes in the same order. A network that is slow rather than stuck gets the
  full time after two tries.
- A half-open connection looked open, and Live sat on the minute's poll. The
  app checks that its pings are answered, every five seconds while Live is
  open and every 25 otherwise, and opens a new connection when one goes
  unanswered.
- Coarse fixes no longer scribble over a Live trail or move the dot back. Each
  minute's hold took a fresh Wi-Fi grade fix, and a parked Android phone's
  resting request keeps delivering under the live one. A hold on a window
  already live now only moves its end, a fix far looser than the ones around
  it is left out of the trail, and the minute's poll and the socket are merged
  by time, so an answer that lost the race can't step the dot back.
- During a firewall lockout a phone on Live tried again with every fix, a
  request a second from the household's address. It now waits 2, 5 and then
  10 seconds with every fix kept, and any retry already waiting keeps its
  timer instead of going again with the next fix. The Live page sends at most
  one ask in ten seconds however often you pull to refresh, and a `429` reads
  as too many asks rather than as a server that couldn't be reached.
- A Live page held open on somebody who had left the circle got a 404 every
  minute, and one held open by somebody removed from the circle a 403. Both
  are answered `watching: false`.
- Live follows with a short straight glide rather than a fly animation every
  second, and stops following once you move the map, with a Follow button to
  pick them up again. On an iPhone, pulling down Control Centre no longer
  closes the app's connection to the server. Only the background does.
- A circle that sees somebody approximately got a frame every second while a
  precise circle watched them on Live, which timed each step across a grid
  line. It now sees the time of their last fix on a five minute clock and
  hears of them only when the grid cell or those five minutes change.
- Somebody signed in on a phone and a tablet had their dot pulled back home
  every quarter hour by the tablet's parked report, and the tablet's battery
  could raise the low battery alert. A device that says it is lying still no
  longer takes the dot from another of theirs that is still reporting, and a
  device on the move takes it at once. _Signed-in devices_ marks the one the
  map follows, and `GET /auth/sessions` gains `onMap`.
- A circle could be set to keep history for up to ten years while the server
  pruned at its own ceiling, 90 days by default. The app now offers nothing
  longer and says why. Server-info gains `maxHistoryRetentionDays`, and the
  server stores a longer setting as the ceiling rather than refusing it.
- An invite code that didn't work at sign-up left the new account in no circle
  with no word of why. The register response gains `invite`, and the app says
  what went wrong.
- Invites said "Expires just now" whatever was left. A time ahead now reads
  "in 3 days", and one of anything no longer reads "1 members", "1 users" or
  "1 circles".
- The server screen told an Android phone to type `http://`, which a store
  build can't use for any server, a home one included. It suggests that only
  where the build can use it, and otherwise says the app connects over HTTPS
  only. The Play listing no longer says a local address over plain HTTP works.
- On Android the setup checklist says "Allow all the time", the words on
  Android's own screen, where it said the iPhone's "Always".
- The units switch says miles, feet and mph rather than Fahrenheit, which the
  app never shows.
- The back button is named for a screen reader, toasts are read out as they
  appear, and an error stays up at least six seconds, longer if it is long.
- The app, the README, the docs, the landing page and the store text said
  nothing goes anywhere but your server. They now name what does, which is map
  tiles from the map host, street names from the phone's own geocoder, Apple's or
  Google's, push, and an Android build with Firebase registering with Google
  when it starts. The landing page says 1.2, and the docs describe the admin
  portal.

## [1.2.0] - 2026-10-02

An admin portal at the server's own address, notifications that gather one
person's news into one, and a fix for phones behind a firewall that locks out
an address after a failed request. Update the server first. Migration 0011 runs
on start. Phones work with either version, and the grouped notifications need
nothing from the app.

### Added

- An admin portal at the server's own address. Sign in with an administrator
  account in a browser. Its dashboard shows the last two weeks of activity and
  whether each person's phone is reporting. From there you can see what in the
  setup needs attention, manage accounts and their devices, set a new password
  for somebody who forgot theirs, read the circles, change who can sign up,
  work the notification queue and read the audit log. It shows no positions
  and nobody else's notification text. Setting somebody's password asks for
  your own first, and a portal session ends after twelve hours.
  `ENABLE_ADMIN_PORTAL=false` turns it off.

### Changed

- Through Expo, news about one person shares one notification that grows a
  line at a time: where they went under their name, their messages under the
  sender's, and battery and silence under their phone. Two quiet hours start a
  new one. A trip that ends at a saved place no longer buzzes on its own. Its
  distance goes on the arrival line instead. The same news through two circles
  is sent once, a backlog lands as one update, and a resolved SOS replaces the
  SOS. ntfy and Web Push still get each notification on its own.

### Fixed

- A phone whose token the server refused, because it was signed out from
  another device or its token ran out, sent the same token again whenever its
  renewal got no answer. Behind a firewall that locks an address out after a
  failed request, each of those refusals locked out every phone at that
  address again, and a phone signed out from elsewhere never learned that it
  was. The app now renews before it sends a refused token again, and renews a
  minute before a token runs out, so a phone that is fine never has its token
  refused. The admin portal does the same.

## [1.1.0] - 2026-10-01

Fixes from a security and code review before the repository went public,
fixes a real family's week turned up in trips, departures and activity
labels, and two new quick messages. Update the server first. Migrations 0009
and 0010 run on start. Phones work with either version, and a new app on an
older server sends the new quick messages as plain text.

Three things change for an existing install:

- The compose files publish the API and ntfy on `127.0.0.1` only. If anything
  reaches port 4000 from another machine, a proxy elsewhere or phones on the
  LAN, set `HEARTH_BIND=0.0.0.0` in `.env`.
- With ntfy, every phone gets a new topic once, the next time the app
  registers. Subscribe again to the topic the app's notification settings
  show.
- Signing in again on a phone ends the session it had before.

### Added

- Two quick messages, "Please charge your phone." and "Your location isn't
  updating. Please open Hearth." The message sheet puts the ones that fit the
  other phone first: charging for a phone at or under the circle's low
  battery line, opening Hearth for one that has gone quiet, the road for
  somebody driving. Every message stays on offer.

### Security

- A stolen refresh token is caught however many times the thief rotates it.
  Each session remembers the last sixteen tokens it spent, a lost answer is
  retried once from the same device, and any other reuse ends the session
  with an audit row.
- Signing in again from a device revokes its old session, so a socket or an
  access token from before stops working.
- Going back to precise no longer opens up what a pause hid. History, the
  trips list and trip detail start from the moment the member returned to
  precise, and a trip that began during a pause or while approximate is never
  announced to that circle.
- A former member's export no longer lists the current, edited places of a
  circle they left.
- A removed member cannot rejoin through an invite made before the removal,
  and their own invites are revoked. Only the owner sees the invite codes
  that make an admin.
- A check-in in the feed loses its coordinates and place name once the member
  stops sharing precisely with that circle, as the check-ins list already did.
- The admin outbox view shows the text of the admin's own notifications only.
- News of an arrival, a departure, a speed or a trip waiting in the outbox is
  dropped if the member stopped sharing precisely with that circle meanwhile.
- The login throttle counts an IPv6 client by its /64, and each account takes
  at most 100 sign-in attempts an hour from anywhere.
- Web push checks an endpoint's address when it connects, so a name
  repointed at an internal host is refused.
- A paused member's circle is no longer sent an empty websocket frame for
  every upload, which gave away when they moved. Sockets have a frame budget.
- The app never falls back to plain HTTP for a public server name, only for
  addresses that can only be on the local network.
- A build allows plain HTTP to any host only for the EAS development profile
  or with `HEARTH_ALLOW_HTTP=1`. A release archived from a plain
  `expo prebuild` used to allow it everywhere.
- The shared tracker log holds no coordinates.
- A nudge no longer queues a fix while sharing is off, and a fix taken while
  an account signs out is dropped rather than uploaded under the next one.
  On Android the native fix file is cleared when tracking stops.

### Fixed

- The server boots from `.env.example` as the quick start describes. A blank
  line such as `ADMIN_NAME=` crashed it, and the Postgres password recipe
  could produce a `/` that broke `DATABASE_URL`.
- A push provider that never answers costs one attempt instead of stalling
  the scheduler. Every send has a 15 second deadline.
- An outbox row another claimant took over keeps the result it wrote, and a
  silent wake past its lifetime is failed rather than retried for an hour.
- The outage guard no longer counts deactivated accounts and long-dead phones,
  which could hold back every offline alert on the server.
- Two administrators demoting each other at once can no longer leave none.
- A speed run replayed from a backlog no longer silences the live alert for
  the same drive.
- An ask to a control channel that went silent without closing goes by push
  after twenty seconds, instead of being reported as delivered for minutes.
- The map's websocket reconnects after its token is refreshed. It usually
  lost that race and left the map on its minute poll.
- The tracker's control channel opens at launch even when the tokens are read
  from the keychain after it asks.
- An upload whose token refresh got no answer is retried, instead of the app
  saying it was signed out.
- A wake push no longer brings up "Updating your location" on an Android
  phone with sharing off.
- A network estimate from a parked phone no longer takes it out of a place or
  makes a trip. A night of cell fixes a street away told a family twice that
  a phone on the nightstand had gone to the neighbours and back. An estimate
  worse than 100 m leaves a place only from more than twice its error away,
  and trips are built without them.
- A drive handed over late by Android's native queue is labelled a drive. It
  went up as walking at 80 km/h, and the speed alert said so. The server also
  refuses a walking or cycling label faster than anybody goes, in the alert
  and on the map.
- When the OS gives no fix as a phone parks, the arrival fix uses the phone's
  newest real position rather than where the stop began.

### Documentation

- `THIRD_PARTY_NOTICES.md` credits Ignite, Expo and the Noto Emoji avatars.
- The privacy page says what a server administrator sees, and SECURITY.md
  lists two trade-offs: registration says whether an email is taken, and the
  per-account sign-in budget can keep an owner out for an hour.
- `MINIO_DATA_PATH` is documented, with how to back it up.
- Dependabot watches the images in the compose files.
- The docs were checked against the code and corrected throughout, push
  notifications most of all: what each provider can and cannot do, and why
  push only fully works in a build made with your own keys.
- The docs site and the landing page share one look and a favicon, and the
  landing page shows the app, with a gallery of real screens.

## [1.0.0] - 2026-09-04

The first stable release, and the first with store listings. The app and the
server now share one version number. No migration and no API change since
0.10.0, so servers and phones can update in either order.

### Added

- A privacy policy and an account deletion page on the website, which both
  stores ask for. Hearth holds no data itself, so the policy says who does,
  what the app sends and where, and the deletion page gives the in-app path
  and what a server keeps afterwards.
- Store listing text, screenshots, graphics and submission notes for the App
  Store and Google Play, with the tools that seed a demo family, capture the
  Release build and composite the screenshots.

### Changed

- The server tests are grouped by feature under `server/src/test`, one folder
  each for alerts, auth, devices, notifications, places, realtime, safety,
  sharing and trips.

### Removed

- Components and helpers that came with the app's boilerplate and were never
  used, and the three dependencies only they needed: date-fns,
  react-native-drawer-layout and expo-network.

### Fixed

- A trip's map frames the route. A fit asked for before the map had loaded was
  dropped, so the trip opened on the whole world.

## [0.10.0] - 2026-08-28

Phones only; the server is unchanged from 0.9.6.

### Added

- "Save this spot as a place" on the profile of anyone settled somewhere no
  place covers. It opens the place editor on their position, with whatever
  the geocoder calls the spot as a first draft of the name.

### Changed

- The Live page holds the display on while it is open. Following someone
  along a road is watching, not reading, and the screen dimmed after
  fifteen seconds.
- Live is offered only for a phone that is travelling and has spoken in the
  last three minutes. A phone last heard from five minutes ago is out of
  signal or asleep, and the page sat on "asking your phone" until the
  window lapsed; the button is a promise that pressing it works.

### Fixed

- Place names no longer read as "near 8H+2W". Android's geocoder answers
  with an Open Location Code wherever it has no street, and that is a
  coordinate spelled differently: plus codes, bare house numbers and
  postcodes are now read as no answer, the district, town or region is used
  instead, and every answer the geocoder gives is tried rather than only
  the first, since the plus code is often first and the street second.
  Cached plus codes from earlier builds are dropped.
- A marker whose faces have all left the circle is no longer drawn as an
  empty view on the map, and a marker is redrawn only when something it
  draws has changed rather than on every fix, which on a watched phone is
  every second.

## [0.9.6] - 2026-08-28

Servers must update before phones: a hold on the Live page falls back to
the push when the phone's channel did not answer.

### Fixed

- Live never came on for an iPhone that had just arrived somewhere. Three
  things, each enough on its own: the iOS live session delivered on
  distance, so a phone standing still sent nothing at all and "live" (a
  fix in the last half minute) could never be claimed; the one fix the ask
  did produce was stamped a few seconds before the ask reached the phone,
  and only a fix from after the ask counted; and an ask sent down a control
  socket iOS had let die without a close was sent down it again on every
  hold for the whole window, since the socket's stamp stayed fresh for
  minutes. The live session now has no distance filter on iOS, a fix from
  up to thirty seconds before the ask counts as the phone's position now,
  and a channel ask nobody answered within twenty seconds is not trusted
  again on the next hold, which goes by push.

### Changed

- Live is a fix a second, every one uploaded, on both platforms and
  whether or not the phone is moving, for as long as somebody has the page
  open. It was one every five seconds, thinned to one every fifteen for a
  phone that was not moving.

## [0.9.5] - 2026-08-27

Phones only; the server is unchanged from 0.9.4.

### Fixed

- Tapping a face on the map on iOS sometimes lit it up and put it straight
  back. iOS's map recognises a single tap only once its double-tap
  recogniser has given up, a third of a second after the face's own press,
  and later still while the card is drawn and the camera flies; that late
  report of the same tap was read as a tap on empty map, which clears the
  selection. The map's report is now taken as the same tap for longer.
- Sending a quick message said "Asked {name} to update their location".
  It now says which message was sent.

## [0.9.4] - 2026-08-27

Server only; no app change.

### Fixed

- A journey between two named places is a trip whatever its length. A
  family member walked three hundred metres from home to the clinic next
  door; the feed said "left Home" and "arrived at Clinic" and the trips
  list said nothing, twice over: the silence between his last fix at home
  and his first at the clinic was read as a stop rather than the journey,
  because the phone had been parked before it, and the path was under the
  400 m a trip needed. A silence of up to 45 minutes from one named place
  to a different one is now the journey between them, beginning at the
  last fix at the origin, and a trip from one named place to another is
  exempt from the length rules. Its start and end places, and the feed,
  now agree.

### Changed

- A journey to somewhere unnamed needs 250 m of path rather than 400 m.
  Drift around a house is kept out by how far the phone got from where it
  started, so the path rule only has to be more than a walk to the car.

## [0.9.3] - 2026-08-26

Servers must update before phones: a phone on an older server can still be
signed out by a lost refresh answer, which is what this release stops.

### Fixed

- A phone no longer signs itself out when the answer to a token refresh is
  lost on the road. The refresh reached the server, which rotated the
  token; the phone never heard, kept the spent one, and presented it at
  its next upload. The server recognised the retry and kept the session,
  but still answered 401, and the app reads a 401 from `/auth/refresh` as
  the end of its session: tokens cleared, tracker stopped, nothing said.
  One family phone stopped reporting for two hours over one lost packet,
  and read as "at home" the whole time. The server now answers a retry
  from the device the token was issued to, within one access token's
  lifetime, with a fresh pair; the grace is counted from the rotation the
  phone missed, so a token cannot be retried for ever.
- When the app does sign itself out with nobody looking at it, it says so
  on the shade, "Signed out of Hearth", so a phone that has gone quiet for
  that reason is never mistaken for one that is fine.

## [0.9.2] - 2026-08-24

The Android tracker's transport is native. No server change; the image is
republished so the version reads the same everywhere.

### Changed

- On Android, everything that has to survive the app's process being
  killed now lives in Kotlin, in `modules/hearth-motion`: the receivers
  the OS wakes on a geofence exit or an activity transition, the
  foreground service they start inside the moment Android allows a start
  from the background, the location request that service owns, and a
  queue of the fixes and events it saw while JavaScript was down. The
  JavaScript tracker keeps the policy (tiers, the stop, the drive, place
  crossings, uploads) and drains the queue, woken headless when it has to
  be. Before this, both departure triggers reached a JavaScript handler
  and the service was started from there, seconds after the moment Android
  had granted for it: with a warm process that fit, with a cold one the
  start was often refused and the phone spent the first hour of a journey
  on a background app's few fixes an hour. The activity transition could
  not wake a dead process at all, since its receiver was registered at
  runtime. A phone exempt from battery optimisation was never refused,
  which is why it worked for some and not for others.
- The moving tiers on Android run under that service, which owns the
  request; the parked tier keeps expo's Wi-Fi grade request with no
  service, so no notification stays. The notification while moving is not
  ongoing: from Android 13 it can be swiped away and the service runs on.
  A reboot or an update puts the classifier's requests and the fence back
  and restarts the service for a phone that was on the move.
- A walk from a parked phone is confirmed under the brief service, which
  the native side brings up for the transition, so the confirming fix is
  no longer one a background app is held to a few of an hour.

### Fixed

- A one-shot fix the OS answers from its cache is asked for again. An
  iPhone opened after hours away asked for a fix and iOS handed back the
  one it still held from where the phone had been; uploaded with its own
  timestamp, the server never moved presence back to it, and the row went
  on saying "two hours ago, at home" until a later open got a fresh one.
  A fresh request answered with a fix over a minute old now asks once more
  inside the same deadline, and every report logs the fix's age.
- The channel expo-location's service used is deleted, so an upgraded
  install does not keep showing "Location sharing" in its notification
  settings next to the native service's "Location updates".

## [0.9.1] - 2026-08-23

Servers must update before phones: the app opens no pings of its own and
relies on the server's slower heartbeat for its control socket, and a
parked Android phone is reached by a push that starts a native service.

### Changed

- A phone's control socket is pinged every two minutes instead of every
  thirty seconds, and the phone sends no pings of its own: a phone in a
  pocket wakes its radio for every frame, and the on-screen socket's pace
  was a hundred and twenty wakes an hour. The channel's stamp is valid for
  five minutes, and a socket that misses two pings is dropped, which clears
  it at once.

### Fixed

- Every Android phone said "their phone stopped Hearth in the background"
  the moment it parked. A parked phone runs no service on purpose, and the
  check that read a missing service as a death was written for a design
  that kept one in every tier. A death is now only what the moving tier's
  re-assert finds, and a phone that parks forgets one.
- A parked Android phone answers an ask the way a messaging app checks for
  messages. A high priority push now starts a native wake service inside
  the message handler, the one moment Android lets a background app start
  a service, with "Updating your location" shown for the second the fix
  takes and gone with it; the fix is taken and uploaded under that service.
  The start used to come from JavaScript after a headless boot, seconds
  late and outside that moment, and a silent push that posted nothing was
  the kind FCM demotes. No connection is held open by a parked phone.
- The control channel renews its own token. A parked phone may make no
  REST call for a quarter hour, and a socket refused after the token
  expired used to wait for one; the channel now rotates the token itself
  and reconnects, and a refusal from before sharing was switched off no
  longer stops it opening when sharing comes back.
- The control channel opens at boot. A process the OS restarted in the
  background, an iPhone relaunched by a location event or an Android phone
  relaunched for a delivery mid-drive, ran without it until the next tier
  change, so a page opened on that phone fell back to push. A page opened
  before a member's presence has loaded asks their phone too.

## [0.9.0] - 2026-08-17

An ask now reaches a phone that is awake within a second. Servers must
update before phones: the app opens a control channel on the websocket and
calls `POST /circles/:id/members/:userId/refresh`.

### Added

- The phone's control channel. The tracker keeps its own websocket to the
  server whenever its process is alive with a location session (Android on
  the move, iOS always) and declares it with `{ type: "control" }`. A watch,
  a page opened, the map opened and the sweep's wake go down it and are
  answered at once; the silent push is kept for a parked Android phone,
  which has nothing open. Server: `user_presence.control_seen_at`
  (migration 0008), `control` frames on `/ws`.
- `POST /circles/:id/members/:userId/refresh`: opening a member's page asks
  their phone for one fix now, at most once per half minute per phone.
- The tracker keeps the circles' places and uploads the fix that crosses
  into or out of one at once, whatever the distance gate says, so an
  arrival is announced on the crossing fix rather than minutes later on
  the park fix. The map's places queries feed it, and the tracker fetches
  them itself once a day for a phone that is never opened.

### Changed

- The watch reply's `pushed` gains `socket`. The sweep's wake goes over the
  channel first and by push second, and no longer needs a push provider for
  a phone with a channel open.
- The SOS note scrolls above the keyboard instead of under it.
- Someone joining or leaving a circle refreshes the map's dots, not only the
  member list.

## [0.8.0] - 2026-08-14

Why the family's phones went silent, taken apart and put back. Servers must
update before phones: the app reads `pushed` and `lastHeardAt` off the watch
reply, and the batch route now records every upload.

### Added

- A phone that uploads has been heard, whatever it uploaded. The server
  records the moment (`user_presence.last_heard_at`, migration 0007) and
  measures silence from the later of the last fix and the last upload, so
  a phone retrying a batch or draining old fixes is never called offline.
- The watch reply says what became of the phone: whether a silent push was
  `sent`, `held` because one went moments ago or the phone has uploaded
  since, or impossible for want of a push token (`no_device`) or a provider
  that can carry one (`unsupported`), along with the last fix, the last time
  the phone spoke, what it was doing, and what it said stands in its way.
  A phone that has not uploaded since the first push is asked again after
  ninety seconds, three times per window at most.
- A phone can report that its background activity is restricted, that a
  power saving mode is on, which vendor made it, and that its location
  service was stopped without being asked. The circle sees these under the
  member's name and the offline alert names them.
- `POST /auth/refresh` takes the device id. A spent refresh token replayed
  by the device the session belongs to, inside one access token's lifetime,
  is a phone racing itself between two runtimes and is refused without
  ending the session. From anywhere else it still ends the session.

### Changed

- One speed rule for the speed alert and the trip card (`agreedMaxSpeedMps`
  in the shared package). Fixes that measured a speed are paired across any
  that measured none, two readings within a tenth of each other stand at the
  faster and any other pair at the slower, and the answer is floored at the
  ground covered between two sharp fixes. A drive announced at 92 km/h was
  filed with a top speed of 21, below its own average, because the card
  paired only adjacent fixes and every road-speed fix on a mixed GPS and
  network stream sat between two that carried no speed.
- Parked is judged from everything the server knows, not from the one label
  the phone may never have managed to send: the last fix said "still", or
  the member is inside a named place, or the last fix measured under 1 m/s
  with an accuracy of 250 m or better. A parked phone gets the twelve-hour
  rule; one last seen on the road, the hour.
- A phone the server can push is only called offline after two wakes have
  gone unanswered. Wakes follow a schedule measured from when the phone was
  last heard: at 10, 20 and 40 minutes for a phone last seen moving, every
  half hour up to three times for a parked one, and the count starts again
  the moment the phone uploads anything. One wake per silence, and one lost
  push, used to be "stopped reporting" at 61 minutes.
- The park fix lands even when it shares its timestamp with the fix that
  settled the phone, which on Android it always does. A stop re-reported at
  the same instant adopts "still" onto the stored fix and the presence row,
  instead of being dropped as a duplicate and leaving the phone "driving"
  at Home for the offline sweep to judge by the wrong rule.
- Silent pushes carry a lifetime: a minute for a watch, five for a wake, ten
  for a nudge. A wake held back by Doze used to be delivered whenever, up to
  weeks later. On iOS a content-available push travels at normal priority,
  which is what Apple documents for a background push; Android stays high.
  The per-phone guards count only pushes that are in flight or went, so a
  push skipped for want of a token no longer holds the next one back for
  ten minutes.
- The speed alert is gated on the device's own history rather than the
  member row, so a tablet landing a fix a moment after the phone's batch
  cannot swallow the phone's fast run.
- The tracker no longer goes quiet at home. On Android the location service
  runs while the phone is on the move and goes with the stop, so nothing
  stays in the shade; a parked phone brings it up for the second a wake's or
  a watch's fix takes and drops it with the fix, the way a messaging app
  checks for messages. Starting it from the background at any moment is what
  the battery optimisation exemption buys, so the checklist's exemption and
  keep-alive steps are what keep a parked Android phone reporting: without
  them Android hands a background app a few fixes an hour and none in Doze,
  which is how a family member sitting at home came to be "not reporting"
  an hour after arriving. On iOS a parked phone keeps a cell-only
  location session instead of none, so it stays alive to say "still here"
  every quarter hour and to notice leaving. Both platforms send the arrival
  fix, stamped still, before the request steps down, and make one up from
  the parking spot if the OS does not answer in time. A phone being watched
  on the move goes live; a parked one answers each ask with one fix and the
  window stays held, so a departure inside it goes straight to live. Every
  one-shot
  fix has a deadline, failed uploads retry on their own, a red light no
  longer parks a car, Android's network fixes stop reading as a stopped car,
  the drive survives a background relaunch, and the diagnostics log records
  what each report, upload and service start came to. The expo-location
  patch grows two changes: a restarted Android service promotes itself so a
  redelivery cannot crash the app, and iOS one-shot fixes are served in the
  background.

## [0.7.0] - 2026-08-03

What a week of family feedback said was unreliable, taken one item at a
time: a feed in the wrong order, trips that never appeared, trails drawn as
rulers across town, a page that had to be pulled to refresh. Servers must
update before phones: the app reads `watchedUntil` off the upload reply and
the feed cursor changed shape.

### Added

- A phone Android will not let start its service is retried at the moments
  Android allows (a transition, a fence exit, a push, the app opening) and
  otherwise once per ten minutes, since re-registering hands back the fix
  the OS already had and retrying on that spun. A stop the phone cannot arm,
  because its permission dropped to "while using", is not retried on the next
  fix, and the checklist takes over. A parked iPhone's session carries no
  distance filter, the shape iOS 16.4 and later suspend.
- Live. A member's profile offers a Live button while their phone says they
  are on the move. It follows them on the map at the zoom you choose, shows
  the speed they are doing and the street they are on, and draws the trail
  from the fixes that arrive while it is open, dashed across any stretch it
  missed. Their phone is asked to report every few seconds for as long as
  the page is open, and nobody else's is.
- A phone learns it is being watched from its own upload reply
  (`watchedUntil` on `POST /locations/batch`), so a car already reporting
  goes live on its next fix whether or not the silent push got through.
  Server: `user_presence.watched_until`, migration 0006.

### Changed

- The activity feed is in the order things happened, and pages by it. A
  backlog uploaded after an outage used to put the morning's arrivals under
  lunchtime's. The cursor carries the moment to the microsecond, which is
  how Postgres stamps it, so rows written in the same millisecond are not
  skipped between pages.
- A trail is drawn only where the phone reported it. A silence between two
  fixes is dashed, and the trip says so, instead of a straight line that
  looked like the route.
- A member's profile shows where they are, not the day's breadcrumbs, and
  no longer asks their phone to go live just for being opened. Live does
  that.
- The trip detector reads a silence between two fixes as travel when the
  phone was clearly somewhere else afterwards, at a pace a person could have
  kept, and the fix before the silence still showed travel. Fixes ten
  minutes apart used to cut a drive into single points, and single points
  are never a trip. A resting fix from where the drive ended still ends it,
  a fix a kilometre out with a kilometre of doubt vouches for nothing, a
  walk across one large place stays inside it, a silence longer than half
  an hour is a lost journey rather than one under way, and a silence with
  another trip's fixes inside it is never bridged. A fix too lonely to be a
  journey is kept for one to grow from, and a trip already filed grows by
  the same rule, so a drive is assembled fix by fix the way the sweep meets
  it, not only when the whole of it is uploaded at once.
- The app refetches the feed, presence and trips every time its socket
  reconnects, which is every time it comes back from the background. A feed
  scrolled deep is cut back to its first page first, so the refetch is one
  request. A feed event that arrives late over the socket lands where it
  happened, or waits for the page it belongs to.
- New places default to a 100 m radius. 150 covered the whole street.

### Fixed

- The feed no longer scrambles after a phone uploads a backlog.
- A drive out to a kilometre away and back, reported sparsely, now counts.
- The Activity page no longer needs a pull to refresh after the app was in
  the background.

## [0.6.0] - 2026-07-31

A fresh look at what the family actually sees against what a family safety app should do,
with the three things that kept happening (a phone called offline on the
sofa, journeys that merged or vanished, a notification that stayed) traced
to their causes. Servers must update before phones: the app calls
`PATCH /me/health` and the offline rule reads what the phone reports.

### Added

- The phone tells the server what stands between it and reporting: the
  location permission level, Location Services, Background App Refresh on
  iOS, battery optimisation on Android. The circle sees "Location permission
  is not set to Always" under the member instead of a phone that went quiet,
  and a quiet phone that has said why is reported as such rather than as
  offline. Server: `PATCH /me/health`, `issues` on presence.
- "At Home since 3:15 PM". Presence carries when the member arrived.
- Every fix says what the phone was doing, from the tracker's own tiers:
  still, walking, driving. The rows show a car for a drive, and the server
  knows a still phone is meant to be quiet.
- Tracker diagnostics under You: what the tracker did and why, kept on the
  phone, shareable. The answer to "the notification stayed" is a page, not a
  guess.
- iOS: a real heartbeat while parked. expo-background-task asked iOS for a
  processing task, which runs when the phone is idle and charging, so a
  parked iPhone had none. Patched to an app refresh task, which is what
  Background App Refresh means: up to thirty seconds, about every quarter
  hour when iOS sees fit. The sync task takes a fix on it when the last one
  is a quarter hour old.

### Changed

- A parked phone is not called offline after an hour of the silence it was
  expected to keep; only after twelve. A phone last seen moving that goes
  quiet is still reported after the hour, and the hour's silent wake before
  it. An Android phone is asked for a fix after a quarter hour of quiet, an
  iPhone after half an hour, since iOS delivers a silent push a few times an
  hour at most.
- Trips end at a stop the phone kept reporting from. A phone that arrived
  somewhere and went on delivering a fix every few minutes held the journey
  open all day, so the morning's drive to work and the evening's drive home
  came out as one trip. A stretch of fixes inside a hundred metres for
  longer than the idle gap now ends the journey where the phone arrived and
  starts the next where it left. Two lone fixes at two different named
  places, silence between them at a pace a person could keep, are one
  journey the tracker did not narrate rather than no journey at all.

### Fixed

- Every remaining way a parked phone was brought back to the moving tier
  without leaving, or kept there after stopping, found in a review of
  the tracker and closed:
  - A fence exit is confirmed against a real fix. Android fires fences on
    the fixes it has, indoors a cell tower's. The service comes up first,
    inside the moment Android allows it, and goes straight back down when a
    sharp fix shows the phone clearly still at home. An exit that lands on a
    phone already moving only re-asserts the service.
  - A vehicle verdict on a parked phone used to enter the moving tier twice
    from a stale snapshot and lose the driving tier it had just entered. A
    doubtful vehicle sample, under 75%, is now confirmed by a fix like a
    walk; a transition, the OS's debounced word, is taken at face value.
  - A still streak counted before a departure no longer parks the phone on
    its first "still" after leaving. One "still" at the lights no longer
    ends a drive; three minutes do, and then park in one step.
  - iOS repeats only the "still" verdict on its schedule. Replaying
    "automotive" un-parked an idling car the tracker had just parked.
  - The on-foot confirmation judged "left" by the still radius, not the
    fence's; a Wi-Fi estimate wandering about a house cleared it. Every
    departure now asks the same question, and the sync task's own stop
    check carries the fix's accuracy like every other.
  - The parking spot survives a suspected departure, so one that turns out
    false settles again on the first fix back inside, rather than five
    minutes later.
  - A drive that ends on the crawl dates the stop from when the crawl began,
    so a parked car is parked five minutes after it stopped, not eight. The
    iOS clock does the same for a walk. A drive can also start from
    displacement, since Android's network fixes carry no speed at all.
  - Switching sharing off goes through the same chain as every other
    registration, so a wake mid fix cannot bring the service back after it.
  - A journey that begins in a fresh process from a wake or a resting fix
    now runs the classifier from the start.
  - A phone with only "While Using" on Android could never park and ran the
    service for good; it now reports from the foreground only until Always
    is granted, as the checklist says.

- On Android the "Updating your location" notification could stay up
  indefinitely at home. A phone that had not moved delivered no fix, since
  the distance filter sat at the OS, so nothing could judge the stop while
  the classifier read a phone in a hand as "tilting" rather than still. The
  request now delivers on the interval whether or not the phone moved, the
  app applies the circle's distance filter to what it uploads, and the stop
  is called from the fixes after five minutes without the classifier's help.
  A fix whose error circle covers the house no longer resets that clock, or
  calls a parked phone gone. And a phone handled in bed, which Android's
  classifier reads as walking at fifty or sixty percent, no longer brings the
  service back on that word alone: on foot, the verdict has to be confirmed
  by a fix clear of where the phone parked, and until then the fence decides.
- With the members sheet pulled up over the map, the back button left the
  app. It brings the sheet down now.
- The expo-location patch was applied twice on the second `pnpm install` a
  build runs, and the Android build failed on the duplicate. Patches are now
  applied once by the root `postinstall`, and left alone when already there.

## [0.5.0] - 2026-07-25

The tracker measured against what it is meant to be: a self-hosted family safety app.
Location is not read all the time. It is read while the phone is moving,
read closely while somebody is watching, and left alone while the phone sits
still. Servers must update before phones: the app calls two new routes.

### Added

- Watching. Opening a member's page asks their phone, by silent push, to
  report at full accuracy every few seconds for ten minutes, and the page
  keeps asking while it is open. A parked phone answers with one fix. This is
  the only time the GPS runs on a phone nobody is driving, and the only time
  a car is drawn moving along a road, which is when somebody is looking.
  Server: `POST /circles/:id/members/:userId/watch`.
- Opening the map asks every member's phone that has been quiet for a couple
  of minutes for one fix, at most once every ten minutes per phone whoever is
  looking. Server: `POST /circles/:id/locations/refresh`.
- Street names. Under a member with no named place, and at both ends of a
  trip, the phone's own geocoder names the street: "Near Queen Street,
  Bristol" instead of "Unnamed spot". Answers are kept on the phone. Off in
  Settings for anyone who would rather their phone did not ask a geocoder
  about the family's whereabouts.

### Changed

- A parked iPhone runs no location session at all. The fence around where
  it stopped relaunches the app when it leaves, and the server's silent push
  is the heartbeat while it sits. That is the only way it shows no location
  indicator in the Dynamic Island and costs nothing, and it is what a commercial app
  does. The blue background indicator is off in every tier; the small arrow
  still shows while location is actually read, as it does for every app.
- A parked Android phone answers a wake or a nudge with the service up for
  the length of one fix and down again after, so the fix is not subject to
  background location limits or Doze and the notification shows for a second
  or two. Posting a notification for a high priority push is also what keeps
  the app's pushes at high priority.
- Opening the app asks for a fix of your own straight away when the last one
  is older than ten seconds, and your dot moves the moment the fix lands
  rather than after the upload and the frame back.
- Arriving somewhere is reported from where the phone actually settled, with
  one Wi-Fi grade fix the moment the stop is called, rather than whenever the
  next fix happened along.
- Trips are journeys. A run that starts inside a place has to leave it, so
  an afternoon in the garden is no longer filed as a trip, while a walk to a
  friend's house still is.

### Fixed

- Android never got its location service back after parking. expo-location
  refuses to register a location task with a foreground service unless the
  app is in the foreground, which is not where a geofence exit or a
  classifier verdict finds it, and the refusal failed the whole registration
  and left the fence torn down. The patched expo-location now makes the
  attempt, catches only Android's own refusal of a background start, and
  tells the app what happened. A journey that starts at a moment Android
  allows (a geofence exit, an activity transition, a high priority push, or
  any time once the app is exempt from battery optimisation) gets the
  service; one that starts at any other moment keeps its fence armed and
  runs on the plain request until the fence exit or the next push brings the
  service up. expo-location is now built from source on Android so the patch
  is in the build at all: Expo ships it as a prebuilt library, and the patch
  in the two previous builds never reached a phone.
- The motion classifier on Android now also asks for activity transitions,
  which are the exempt trigger Android names, so a journey the classifier
  notices can start the service itself.
- An iPhone put down went silent until it moved far enough for iOS to relaunch
  the app. iOS was allowed to pause the updates when it judged the phone
  still, which suspends the app, and a suspended app never called the stop
  or armed the fence. The updates no longer pause while moving. Core Motion
  also only reports an activity when it changes, so the ninety second
  stillness check never got its second reading; the native module now
  repeats the current verdict every thirty seconds, as Android's classifier
  does. A clock in the tracker stands behind both, calling the stop after
  five minutes without a fix, and never while the phone is driving.
- The end of every journey was held back. Deferred delivery looked like the
  OS batching for battery and was not: expo holds the fixes in the process,
  and the ones held were the last of every journey, the fixes that say where
  the phone stopped. They surfaced on the next delivery, which a parked phone
  never made, so arrivals were announced and trips filed a quarter of an hour
  late or not at all. Deferred delivery is gone from every tier.
- A re-registration of the location request mid drive, from a wake or a
  policy change, dropped the GPS tier for the rest of the drive. One place
  now derives the request from the tier the tracker is in.
- The Background App Refresh row on the iOS checklist read "Check" whatever
  the switch said. It now reads the switch itself, through the native
  module, and shows On or Off.

## [0.4.0] - 2026-07-22

The tracker after a proper look at how the platforms behave. Servers must
update before phones: the server carries a migration, and the wake needs it.

### Added

- A driving tier. While the phone is in a vehicle the tracker uses the GPS,
  reports every ten seconds with a filter that follows the speed, and defers
  nothing, so the map shows a driver on the road with a real speed. Nowhere
  else is the GPS on

- A silent wake. A phone quiet for half an hour is sent a push with nothing
  to show, and answers it with a fix from the background, even with the app
  closed. A phone is only reported offline once it has ignored both its own
  heartbeat and the wake
- The admin screen shows each account's longest silence over the last day

### Fixed

- The exit fence around a parked phone is 200 metres on iOS, which is the
  smallest region iOS reliably reports leaving
- A parked phone was reported offline to its family. The location service used
  to stop altogether once the phone had settled, leaving its next report to
  the OS task schedulers, and Doze and iOS both let it sit for over an hour.
  The service now steps down to a cheap Wi-Fi grade watch instead and checks
  in every quarter hour. On Android the notification therefore stays while
  parked, collapsed and silent as before

## [0.3.2] - 2026-07-12

The second day on two phones. The server change is the low battery text.

### Changed

- Directions on a member's page offer Google Maps on iOS too, when it is
  installed, next to Apple Maps
- Alerts fade and settle in rather than appearing in one frame
- The Change password sheet is titled like the Name prompt beside it
- A low battery alert names the phone it is about, so it reads on its own in
  the tray next to everything else
- The map banner for your own SOS says it is yours and takes you to the
  screen where you can call it off, instead of telling you that you need help

### Fixed

- On iOS, "I'm safe now" on the SOS screen did nothing until the screen was
  closed, and then showed one confirmation for every tap. Alerts now draw in
  a window above native modal screens, and a repeated tap does not queue
  another copy
- Saving from a sheet's button left the keyboard up after the sheet had gone
- The You screen shifted every thirty seconds while the app was open, because
  the tracking row grew a "queued" note for the instant a heartbeat fix waited
  to upload

- Tapping a member on the map did nothing but move the camera. On Android the
  map received the same tap and cleared the selection at once, so the member
  card never appeared. A tap now flies to them and names them at the top of
  the sheet, a second tap on them or on the card opens their page, and a row
  in the list opens the page as its chevron promised

## [0.3.1] - 2026-07-08

Faster alerts on the server, and the app fixes from a day of using it on a
phone. The server carries a migration.

### Added

- Confirmations, prompts and option sheets are drawn by the app in its own
  theme rather than by the system, so they look the same on both platforms

### Changed

- Notifications go out the moment the event that caused them is committed.
  Postgres wakes the worker instead of the worker checking every minute, sends
  run several at a time, and the most urgent go first. Every notification is
  now sent at high priority, so a phone in Doze shows it at once
- The Android notification shown while a journey is being followed no longer
  puts an icon in the status bar. Android will not run background location
  without a notification, so it cannot go away entirely, but it now sits
  collapsed in the silent part of the shade
- Deactivating a user or changing who is an admin asks first

### Fixed

- Every prompt sheet crashed the moment it opened, because the sheet host sat
  outside the theme. The Android back button now closes a sheet instead of
  the screen under it
- The battery optimisation row on the setup checklist read On with a Review
  link beside it as soon as the dialog had been shown. It now reads what the
  OS says
- The SOS notification channel asked for a sound file called default, which
  does not exist, and so had no sound

## [0.3.0] - 2026-06-30

The first round of fixes from using the app on a real phone, and a new app
identifier. Servers must update to this version before phones do, because the
new app reports heartbeat fixes that an older server rejects.

### Added

- A heartbeat location source. While the app is open and the phone is parked
  it takes one cheap fix at the circle's interval, so your own row no longer
  goes stale on the map. Trip detection and the possible-incident check both
  ignore those fixes, since a phone reporting on a timer says nothing about how
  it came to a stop

### Changed

- The phone's motion classifier is no longer a switch on the You screen. It
  runs whenever location sharing does, and the Motion and Fitness or physical
  activity permission is asked for on the setup checklist like location is.
  Refusing it leaves the phone working stops out from position, as before.
  Existing installs are walked through the checklist once more to see the new
  row
- The tracker only ever checks the motion permission. The checklist's Allow
  button is the one place that asks, so a background wake can no longer make a
  request that Android answers as denied without showing a dialog
- The app identifier is now `com.binary.rewind.hearth` on both platforms. A
  build with the new id installs beside the old one rather than over it, so
  remove the old app once you have signed in on the new one

### Fixed

- Sheets that a screen mounts hidden and shows later, such as the display name,
  server name, history retention and member nickname prompts, never opened.
  Every one of them opens now, and opens again after being swiped away
- Text fields inside a sheet now rise with the keyboard, and the first tap on
  Save lands while the keyboard is up. Change password gained the subtitle and
  spacing the other sheet forms have, and shows the server's error instead of
  a red hint
- Your own row on the map read as stale after fifteen minutes with the app open
  and the phone parked. See the heartbeat entry above
- The members sheet on the map stopped short of the status bar when expanded,
  and the map controls slid under the bar. The sheet now meets the bar and the
  controls stop level with the circle switcher and fade out
- Signed-in devices printed the raw platform name for a session without a
  device name, and the sign-out confirmation for such a row was blank

- Signed-in devices no longer lists a session whose refresh token has lapsed.
  It could not sign in again, so it was never a device to sign out

## [0.2.0] - 2026-06-26

A correctness and security pass over the server, the alert logic and the mobile
app. This release fixes 58 defects and adds the tests that hold them in place.

### Security

- A single websocket frame from any signed-in account could take the whole
  server down, ending live location, SOS and check-ins for every family on it
- The activity feed and the place-events endpoint ignored the target's sharing
  state, so a circle somebody had stepped back from could still read the named
  places they had been to
- A timed pause that lapsed resolved to precise rather than to the state it
  replaced, handing exact coordinates to a circle that had been given a grid
  square. Fixed in all three places that resolve it
- Server-admin was read from the access token rather than the database, so
  demoting an administrator did not demote them, and within the token's life
  they could promote themselves back permanently
- The login throttle no longer believes a forwarded address from anywhere but a
  proxy on a private network
- Refresh tokens rotate with the superseded hash remembered, so a replay is told
  apart from a phone retrying a response it never received

### Fixed

- A car passing through a tunnel read as a crash, because a fix carrying no
  speed was treated as a measured zero rather than as unknown
- An ordinary arrival raised a crash alert off a single stray sample. Two fixes
  now have to agree before a speed is evidence
- Alert cooldowns lived on the account, so the first circle told spent the
  cooldown for every other circle, and a circle that was paused at that moment
  heard nothing for the rest of the drain. Speed and battery latches are per
  circle now
- Trips merged every device on an account, so a tablet left at home teleported
  the driving phone's route and inflated its distance and average speed
- A completed trip was never announced at all
- Pausing sharing and resuming it announced a fresh arrival at a place the
  member had never left
- Driving past a place no longer buzzes the family. The entry push is held for
  the length of a transit and cancelled by the departure

### Changed

- Member rows, the activity feed and the map no longer re-render on every
  location frame
- The background sync task stops waking the GPS once the phone signs out
- The location queue no longer rewrites itself in full on every fix

## [0.1.3] - 2026-06-25

Everything since 0.1.0. The 0.1.1 and 0.1.2 images went out without release
notes, so this covers all three.

### Added

- Nudges. A one-tap prod that plays on the recipient's map, buzzes their phone
  and lands in the feed. It always goes to one person
- Crash detection that keeps running with the screen off, using a small native
  module that samples the accelerometer, gyroscope and barometer itself
- SOS is marked time sensitive on iOS, and goes out on an Android channel that
  bypasses Do Not Disturb
- Profile pictures, stored in any S3 compatible bucket
- A documentation site, and a landing page for the project
- Android and iOS build profiles, so a release artifact is one command
- The motion permission is on the setup checklist, and the app notices when
  location access is taken away later

### Changed

- Location tracking only runs while the phone is moving, which is most of the
  battery saving
- The first account no longer bypasses the invite gate. An admin account is
  created from the environment instead
- The account export streams rather than loading a whole history into memory,
  and is no longer silently cut off at 100,000 points
- Trips are detected per device, so a tablet left at home stops inflating the
  distance of the phone's drive
- Possible-incident alerts need a stop that lasted, not just a fast fix
  followed by a slow one
- The seven migrations collapsed into a single init. Nothing had been deployed,
  so there was no database to preserve

### Removed

- In-app messaging. Nudges replaced it, and nothing is stored to catch up on
  later

### Fixed

- Geofences no longer freeze on a small place when a fix is coarse, and a
  member who stops sharing precisely stops being reported as inside one
- The retention sweep no longer lets one large account starve the others
- Offline alerts are no longer withheld when a household is simply asleep
- Failures in the app that used to disappear are shown

### Security

- The credential routes are rate limited, and an admin can no longer lock every
  other admin out
- Revocation is enforced on the request path rather than only at refresh

## [0.1.0] - 2026-04-28

First alpha. Everything below is built and tested, but the project has not had a
security audit and there are no store builds yet.

### Added

- Circles with owner, admin and member roles, invite codes, QR joining and deep
  links
- Background location tracking on iOS and Android with an offline queue and a
  server-driven update policy
- Live map over a websocket, with battery, activity and staleness per member
- Per circle sharing modes: precise, approximate on a 750 metre grid, or paused
- Places with arrive and leave events, using hysteresis so a phone on a boundary
  doesn't flap
- SOS with a three second hold, twenty second live pings, and an override of a
  paused sharing state
- Check-ins and location requests
- Messages per circle with one-tap canned replies
- Speed alerts and possible-incident alerts, both off by default
- Trip detection from breadcrumbs, with distance, duration, speeds and endpoints
- Activity feed with unread counts and per member notification mutes
- Push notifications through Expo, self-hosted ntfy, or Web Push, with a durable
  outbox that survives a provider outage
- Data export, history erasure and account deletion
- Admin API and screen for stats, users, registration mode and the push queue
- Docker Compose stack with optional ntfy and Redis overlays

### Security

- Refresh tokens are hashed at rest and rotated on every use
- Passwords use scrypt from Node's standard library, so the image builds on ARM
  without a toolchain
- Every circle route re-checks membership against the database rather than
  trusting the token
- Push payloads never carry coordinates

[Unreleased]: https://github.com/Qureshi-DH/hearth/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Qureshi-DH/hearth/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Qureshi-DH/hearth/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Qureshi-DH/hearth/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Qureshi-DH/hearth/compare/v0.10.0...v1.0.0
[0.10.0]: https://github.com/Qureshi-DH/hearth/compare/v0.9.6...v0.10.0
[0.9.6]: https://github.com/Qureshi-DH/hearth/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/Qureshi-DH/hearth/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/Qureshi-DH/hearth/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/Qureshi-DH/hearth/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/Qureshi-DH/hearth/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/Qureshi-DH/hearth/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Qureshi-DH/hearth/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Qureshi-DH/hearth/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Qureshi-DH/hearth/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Qureshi-DH/hearth/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Qureshi-DH/hearth/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Qureshi-DH/hearth/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Qureshi-DH/hearth/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Qureshi-DH/hearth/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Qureshi-DH/hearth/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Qureshi-DH/hearth/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Qureshi-DH/hearth/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/Qureshi-DH/hearth/releases/tag/v0.1.0
