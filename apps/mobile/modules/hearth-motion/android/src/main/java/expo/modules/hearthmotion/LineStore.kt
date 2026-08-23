package expo.modules.hearthmotion

import java.io.File
import java.io.FileOutputStream

/**
 * An append-only file of one JSON document per line, read and emptied in
 * one go. The service and the receivers write; JavaScript drains. One lock
 * for every store, since they all live in the one process and a line is
 * a few hundred bytes. A store nobody drains is capped rather than left
 * to grow: the newest lines are the ones a tracker coming back wants.
 */
internal class LineStore(private val file: File, private val maxBytes: Long = MAX_BYTES) {
  fun append(line: String) {
    synchronized(LOCK) {
      file.parentFile?.mkdirs()
      if (file.length() > maxBytes) compact()
      FileOutputStream(file, true).use { it.write((line + "\n").toByteArray(Charsets.UTF_8)) }
    }
  }

  fun drain(): List<String> {
    synchronized(LOCK) {
      if (!file.exists()) return emptyList()
      val lines = file.readLines(Charsets.UTF_8).filter { it.isNotBlank() }
      file.delete()
      return lines
    }
  }

  private fun compact() {
    val lines = file.readLines(Charsets.UTF_8).filter { it.isNotBlank() }
    val kept = lines.drop(lines.size / 2)
    file.writeText(kept.joinToString("\n", postfix = if (kept.isEmpty()) "" else "\n"), Charsets.UTF_8)
  }

  companion object {
    private val LOCK = Any()
    /** About five thousand fixes, a day of the live tier with nothing draining it. */
    private const val MAX_BYTES = 1_000_000L
  }
}
