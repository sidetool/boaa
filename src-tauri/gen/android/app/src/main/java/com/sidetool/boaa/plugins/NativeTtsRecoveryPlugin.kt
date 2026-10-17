package com.sidetool.boaa.plugins

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import com.sidetool.boaa.NativeTtsRecoveryScheduler

data class NativeTtsRecoveryScheduleArgs(
  val network: String = "any",
  val charging: String = "any",
)

@TauriPlugin
class NativeTtsRecoveryPlugin(private val activity: Activity): Plugin(activity) {
  @Command
  fun schedule(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(NativeTtsRecoveryScheduleArgs::class.java)
      NativeTtsRecoveryScheduler.schedule(activity.applicationContext, args.network, args.charging)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android native TTS recovery could not be scheduled", error)
    }
  }
}
