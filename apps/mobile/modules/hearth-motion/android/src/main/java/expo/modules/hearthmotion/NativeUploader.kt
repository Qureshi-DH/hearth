package expo.modules.hearthmotion

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.os.BatteryManager
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Sends the fixes that answer a wake or a Live request, from here, with the
 * session's upload key. Android runs no JavaScript timer for an app in the
 * background, and fetch hands every response over on one, so an answer
 * that waited on JavaScript reached the server when somebody next opened
 * the app.
 *
 * A fix waits in its own file until the server has it. One the server took
 * goes into the tracker's queue marked as sent, so JavaScript still learns
 * from it. One that cannot be sent, because the key was refused or the
 * service is going, goes into the queue unmarked and JavaScript sends it.
 */
internal object NativeUploader {
  interface Listener {
    /** On the upload thread. `sentAt` is elapsed realtime. */
    fun onReply(reply: UploadWire.Reply, sentAt: Long)

    /** Everything handed over has gone, one way or the other. */
    fun onIdle()
  }

  private const val TAG = "HearthUpload"
  private const val MAX_BATCH = 100
  private const val CONNECT_TIMEOUT_MS = 10_000
  private const val READ_TIMEOUT_MS = 15_000
  /** Short enough that Live comes back within seconds of the network. */
  private val RETRY_MS = longArrayOf(1_000, 2_000, 5_000, 10_000, 15_000)

  private val worker =
    Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "hearth-upload").apply { isDaemon = true } }

  @Volatile var listener: Listener? = null

  @Volatile private var sending = false
  @Volatile private var scheduled = false
  private var failures = 0

  private fun outbox(context: Context) = LineStore(File(context.filesDir, "hearth-tracker/outbox.jsonl"))

  /** Whether a wake or a Live request can be answered from here. */
  fun ready(context: Context): Boolean {
    val prefs = TrackerPrefs(context)
    return prefs.enabled && prefs.mode != "off" && prefs.uploadUrl != null && prefs.uploadKey != null
  }

  fun configure(context: Context, url: String, key: String) {
    val prefs = TrackerPrefs(context)
    prefs.uploadUrl = url
    prefs.uploadKey = key
  }

  /** Signed out, a server change or sharing off, and nothing more goes from here. */
  fun forget(context: Context) {
    val prefs = TrackerPrefs(context)
    prefs.uploadUrl = null
    prefs.uploadKey = null
    handOver(context)
  }

  fun idle(context: Context): Boolean = !sending && !scheduled && outbox(context).isEmpty()

  fun send(context: Context, location: Location, source: String) {
    val app = context.applicationContext
    val fix = TrackerQueue.fixJson(location)
    val (battery, charging) = battery(app)
    val point = UploadWire.point(UploadWire.fix(fix), source, activity(TrackerPrefs(app)), battery, charging)
    outbox(app).append(JSONObject().put("fix", fix).put("point", point).toString())
    schedule(app, 0)
  }

  /**
   * Sends what is waiting and returns once the server answered or gave up,
   * for the push handler, whose thread is the only one it has when the
   * service could not start.
   */
  fun sendNow(context: Context, timeoutMs: Long): Boolean =
    try {
      worker.submit<Unit> { run(context.applicationContext) }.get(timeoutMs, TimeUnit.MILLISECONDS)
      outbox(context).isEmpty()
    } catch (error: Exception) {
      false
    }

  /** Everything waiting goes to JavaScript to send. */
  fun handOver(context: Context) {
    val entries = outbox(context).drain()
    if (entries.isEmpty()) return
    for (line in entries) {
      runCatching { TrackerQueue.appendFix(context, JSONObject(line).getJSONObject("fix")) }
    }
    TrackerQueue.poke(context)
  }

  private fun schedule(context: Context, delayMs: Long) {
    synchronized(this) {
      if (scheduled) return
      scheduled = true
    }
    worker.schedule(
      {
        synchronized(this) { scheduled = false }
        run(context)
      },
      delayMs,
      TimeUnit.MILLISECONDS,
    )
  }

  private fun run(context: Context) {
    sending = true
    try {
      drain(context)
    } finally {
      sending = false
    }
    if (idle(context)) listener?.onIdle()
  }

  private fun drain(context: Context) {
    val prefs = TrackerPrefs(context)
    val url = prefs.uploadUrl
    val key = prefs.uploadKey
    if (url == null || key == null || !prefs.enabled) {
      handOver(context)
      return
    }
    var waiting = outbox(context).drain().mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
    while (waiting.isNotEmpty()) {
      val batch = waiting.take(MAX_BATCH)
      waiting = waiting.drop(MAX_BATCH)
      val sentAt = SystemClock.elapsedRealtime()
      val answer = post(url, key, UploadWire.body(batch.map { it.getJSONObject("point") }))
      when {
        answer.code in 200..299 -> {
          failures = 0
          for (entry in batch) TrackerQueue.appendFix(context, entry.getJSONObject("fix").put("sent", true))
          val reply = UploadWire.reply(answer.text)
          TrackerQueue.event(context, uploaded(batch.size, answer.text))
          if (reply != null) listener?.onReply(reply, sentAt)
        }
        answer.code == 401 || answer.code == 403 -> {
          // The session ended, or the key is from before a sign-in. Nothing
          // more is tried from here, since a firewall in front of the server may
          // lock the phone out for a run of refusals, and JavaScript hands
          // over a new key with its next tokens.
          prefs.uploadKey = null
          for (entry in batch + waiting) TrackerQueue.appendFix(context, entry.getJSONObject("fix"))
          handOver(context)
          TrackerQueue.event(context, JSONObject().put("type", "upload").put("status", "refused").put("code", answer.code))
          TrackerQueue.poke(context)
          return
        }
        answer.code == 0 || answer.code == 408 || answer.code == 429 || answer.code >= 500 -> {
          // In order, ahead of anything that arrived while this one was out.
          val newer = outbox(context).drain()
          val store = outbox(context)
          for (entry in batch + waiting) store.append(entry.toString())
          for (line in newer) store.append(line)
          failures += 1
          if (failures == 1) {
            TrackerQueue.event(context, JSONObject().put("type", "upload").put("status", "failed").put("code", answer.code))
          }
          schedule(context, RETRY_MS[minOf(failures, RETRY_MS.size) - 1])
          return
        }
        else -> {
          // A batch the server will never take. JavaScript drops it the
          // same way, and its log says why.
          for (entry in batch) TrackerQueue.appendFix(context, entry.getJSONObject("fix"))
          TrackerQueue.event(context, JSONObject().put("type", "upload").put("status", "rejected").put("code", answer.code))
          TrackerQueue.poke(context)
        }
      }
    }
    if (!outbox(context).isEmpty()) schedule(context, 0)
  }

  private fun uploaded(count: Int, text: String): JSONObject {
    val event = JSONObject().put("type", "uploaded").put("sent", count).put("sentAt", System.currentTimeMillis())
    val reply = runCatching { JSONObject(text) }.getOrNull() ?: return event
    for (field in listOf("accepted", "watchedUntil", "serverTime", "policy")) {
      if (reply.has(field)) event.put(field, reply.get(field))
    }
    return event
  }

  private data class Answer(val code: Int, val text: String)

  private fun post(url: String, key: String, body: String): Answer {
    val connection =
      try {
        URL(url).openConnection() as HttpURLConnection
      } catch (error: Exception) {
        return Answer(0, error.message ?: "bad url")
      }
    return try {
      connection.requestMethod = "POST"
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.doOutput = true
      connection.setRequestProperty("content-type", "application/json")
      connection.setRequestProperty("accept", "application/json")
      connection.setRequestProperty("authorization", "Bearer $key")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      val stream = if (code in 200..299) connection.inputStream else connection.errorStream
      Answer(code, stream?.bufferedReader()?.use { it.readText() } ?: "")
    } catch (error: IOException) {
      Log.i(TAG, "upload failed: ${error.message}")
      Answer(0, error.message ?: "network")
    } finally {
      connection.disconnect()
    }
  }

  private fun activity(prefs: TrackerPrefs): String =
    prefs.activity.takeIf { it != "unknown" } ?: if (prefs.mode == "stationary") "still" else "unknown"

  private fun battery(context: Context): Pair<Double?, Boolean?> {
    val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null to null
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    return (if (level >= 0 && scale > 0) level.toDouble() / scale else null) to charging
  }
}
