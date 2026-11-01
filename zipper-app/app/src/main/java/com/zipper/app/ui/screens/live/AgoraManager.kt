package com.zipper.app.ui.screens.live

import android.content.Context
import android.view.SurfaceView
import com.zipper.app.BuildConfig
import io.agora.rtc2.ChannelMediaOptions
import io.agora.rtc2.Constants
import io.agora.rtc2.IRtcEngineEventHandler
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.RtcEngineConfig
import io.agora.rtc2.video.CameraCapturerConfiguration
import io.agora.rtc2.video.VideoCanvas
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

object AgoraManager {
    private var engine: RtcEngine? = null
    var onUserJoined: ((Int) -> Unit)? = null
    var onUserOffline: ((Int) -> Unit)? = null
    var onError: ((Int) -> Unit)? = null

    /**
     * A-6 (APK 20): WHO MINTS A FRESH TOKEN FOR THE CHANNEL WE ARE IN.
     *
     * Tokens expire after one hour and the engine then removes the user from
     * the channel — every live room, party and paid call over an hour was cut
     * at sixty minutes. The engine warns thirty seconds ahead through
     * `onTokenPrivilegeWillExpire`; this is answered by asking the server for
     * a new token for the SAME channel (the server signs for the same uid) and
     * handing it to `RtcEngine.renewToken`.
     *
     * The request itself stays in `AgoraTokenRepository`, the one caller of
     * the Cloud Function; a screen installs it here when it joins. A lambda
     * rather than an injected dependency because this object predates Hilt
     * and every screen already holds the repository.
     */
    @Volatile
    var tokenRenewer: (suspend (channelId: String) -> String?)? = null

    /** Told after a renewal attempt: `true` when the engine took the new token. */
    var onTokenRenewed: ((channelId: String, ok: Boolean) -> Unit)? = null

    private val renewScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var renewJob: Job? = null

    /**
     * How the engine was last joined, so an expired token can be recovered by
     * replaying the join with a fresh one. `onRequestToken` fires once the
     * token has already lapsed; the SDK documents a rejoin for that case, and
     * `renewToken` alone does not always bring the connection back.
     */
    private data class JoinSpec(
        val channelId: String,
        val uid: Int,
        val role: Int,
        val options: () -> ChannelMediaOptions,
    )

    @Volatile
    private var lastJoin: JoinSpec? = null

    /**
     * Who is talking right now, as Agora hears it: uid to volume, 0-255.
     *
     * The local speaker is reported as uid 0 in a callback of its own, so a
     * listener that wants to light its own ring reads 0 rather than the uid it
     * joined with. Off until [enableSpeakingIndicator] turns it on — the
     * callback fires several times a second and nothing outside a party room
     * has any use for it.
     */
    var onAudioVolume: ((Array<out IRtcEngineEventHandler.AudioVolumeInfo>) -> Unit)? = null

    /**
     * True while video is switched off for an audio-only party.
     *
     * The engine is one process-wide object shared by the call screen, Go Live,
     * Watch Live and the party room, so "turn the camera subsystem off" is a
     * change one screen makes to a thing the others own. This flag is what lets
     * [init] put it back.
     */
    private var audioOnly = false

    /**
     * The channel this engine is currently in, or "" for none.
     *
     * ── THE PK RE-JOIN STORM ─────────────────────────────────────────────────
     *
     * `joinChannel` had no memory, so callers had no way to ask "am I already
     * here?" — and one caller badly needed to. The PK join sat inside the room
     * document's snapshot collector:
     *
     *     repo.roomFlow(roomId).collect { room ->
     *         if (room.pkActive && room.pkChannelId.isNotBlank()) {
     *             val t = agoraTokenRepo.fetchGrant(room.pkChannelId)   // a callable
     *             AgoraManager.joinAsBroadcaster(room.pkChannelId, t)   // a rejoin
     *         }
     *     }
     *
     * That collector fires on EVERY field change to the room. During a PK the
     * score is incremented per gift, and `viewerCount` and `likeCount` are
     * writable by any viewer — so a busy battle produced several writes a
     * second, and each one bought a billed Cloud Function call (which does its
     * own Firestore reads) plus a full media renegotiation that both hosts and
     * every viewer saw as a stutter.
     *
     * Tracking membership here fixes it for every caller at once rather than
     * asking each one to remember, and makes a redundant join free instead of
     * expensive. [isInChannel] lets a caller skip the token fetch too, which is
     * the half that costs money.
     */
    @Volatile
    private var joinedChannel: String = ""

    val isInitialized get() = engine != null

    /** True when the engine is already in [channelId]. Check before fetching a token. */
    fun isInChannel(channelId: String): Boolean =
        joinedChannel.isNotEmpty() && joinedChannel == channelId

    /** The channel currently joined, or "" — for teardown that has to name it. */
    val currentChannel: String get() = joinedChannel

    fun init(context: Context, eventHandler: IRtcEngineEventHandler? = null) {
        if (engine != null) {
            // An audio party disables video on the shared engine. If that screen
            // went away without restoring it — a crash, a process death mid-teardown
            // — the next screen to init would come up with a camera that never
            // turns on and no way to tell why. Every caller inits before joining,
            // so putting it back here is free.
            if (audioOnly) useVideo()
            return
        }
        try {
            val config = RtcEngineConfig().apply {
                mContext = context.applicationContext
                mAppId = BuildConfig.AGORA_APP_ID
                mEventHandler = eventHandler ?: object : IRtcEngineEventHandler() {
                    override fun onUserJoined(uid: Int, elapsed: Int) { onUserJoined?.invoke(uid) }
                    override fun onUserOffline(uid: Int, reason: Int) { onUserOffline?.invoke(uid) }
                    override fun onError(err: Int) { onError?.invoke(err) }
                    override fun onAudioVolumeIndication(
                        speakers: Array<out IRtcEngineEventHandler.AudioVolumeInfo>?,
                        totalVolume: Int,
                    ) {
                        val s = speakers ?: return
                        onAudioVolume?.invoke(s)
                    }
                    /*
                     * A-6: thirty seconds before the token lapses. Renewed in
                     * place — the connection and every subscription survive.
                     */
                    override fun onTokenPrivilegeWillExpire(token: String?) {
                        renewCurrentToken(rejoin = false)
                    }
                    /*
                     * A-6: the token HAS lapsed (the renewal above did not land
                     * in time — a backgrounded app, a dead network). Recover by
                     * replaying the last join with a fresh token.
                     */
                    override fun onRequestToken() {
                        renewCurrentToken(rejoin = true)
                    }
                }
            }
            engine = RtcEngine.create(config)
            engine?.setChannelProfile(Constants.CHANNEL_PROFILE_LIVE_BROADCASTING)
            engine?.enableVideo()
            // Lock to front camera — hosts and broadcasters only use front camera
            engine?.setCameraCapturerConfiguration(
                CameraCapturerConfiguration(CameraCapturerConfiguration.CAMERA_DIRECTION.CAMERA_FRONT)
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Join a channel as broadcaster (host or caller).
     * [token] is a server-generated Agora RTC token from the `generateAgoraToken`
     * Cloud Function. Pass null only when App Certificate is disabled (testing only).
     */
    fun joinAsBroadcaster(channelId: String, token: String? = null, uid: Int = 0) {
        val eng = engine ?: return
        eng.setClientRole(Constants.CLIENT_ROLE_BROADCASTER)
        // Mobile parity (stream quality): publish a second, low-resolution
        // stream next to the main one, so a viewer can choose "Low" — or fall
        // back to it on a weak connection — instead of buffering. Best effort:
        // a refusal leaves the single stream exactly as before.
        runCatching { @Suppress("DEPRECATION") eng.enableDualStreamMode(true) }
        val options = {
            ChannelMediaOptions().apply {
                clientRoleType = Constants.CLIENT_ROLE_BROADCASTER
                channelProfile = Constants.CHANNEL_PROFILE_LIVE_BROADCASTING
                publishCameraTrack = true
                publishMicrophoneTrack = true
            }
        }
        eng.joinChannel(token, channelId, uid, options())
        joinedChannel = channelId
        lastJoin = JoinSpec(channelId, uid, Constants.CLIENT_ROLE_BROADCASTER, options)
    }

    /**
     * Join a channel as audience (viewer).
     * [token] is a server-generated Agora RTC token from the `generateAgoraToken`
     * Cloud Function. Pass null only when App Certificate is disabled (testing only).
     */
    fun joinAsAudience(channelId: String, token: String? = null, uid: Int = 0) {
        val eng = engine ?: return
        eng.setClientRole(Constants.CLIENT_ROLE_AUDIENCE)
        val options = {
            ChannelMediaOptions().apply {
                clientRoleType = Constants.CLIENT_ROLE_AUDIENCE
                channelProfile = Constants.CHANNEL_PROFILE_LIVE_BROADCASTING
                publishCameraTrack = false
                publishMicrophoneTrack = false
            }
        }
        eng.joinChannel(token, channelId, uid, options())
        joinedChannel = channelId
        lastJoin = JoinSpec(channelId, uid, Constants.CLIENT_ROLE_AUDIENCE, options)
    }

    /**
     * A-6: ask for a fresh token for the channel we are in and hand it to the
     * engine. [rejoin] replays the last join with the new token, for the case
     * where the old one has already lapsed and the engine has let go.
     *
     * One attempt in flight at a time. A failure is logged and reported
     * through [onTokenRenewed]; the engine then behaves exactly as it did
     * before renewal existed — the user is dropped at expiry — never worse.
     */
    private fun renewCurrentToken(rejoin: Boolean) {
        val channelId = joinedChannel
        if (channelId.isEmpty()) return
        val renewer = tokenRenewer ?: run {
            android.util.Log.w("AgoraManager", "Token expiring for $channelId but no renewer is installed.")
            return
        }
        if (renewJob?.isActive == true) return
        renewJob = renewScope.launch {
            val fresh = try { renewer(channelId) } catch (e: Exception) {
                android.util.Log.w("AgoraManager", "Token renewal failed for $channelId", e)
                null
            }
            val eng = engine
            // The screen may have left while the request was in flight.
            if (fresh.isNullOrBlank() || eng == null || joinedChannel != channelId) {
                onTokenRenewed?.invoke(channelId, false)
                return@launch
            }
            val ok = try {
                if (rejoin) {
                    val spec = lastJoin
                    if (spec != null && spec.channelId == channelId) {
                        eng.leaveChannel()
                        eng.setClientRole(spec.role)
                        eng.joinChannel(fresh, spec.channelId, spec.uid, spec.options()) == 0
                    } else {
                        eng.renewToken(fresh) == 0
                    }
                } else {
                    eng.renewToken(fresh) == 0
                }
            } catch (e: Exception) {
                android.util.Log.w("AgoraManager", "renewToken threw for $channelId", e)
                false
            }
            onTokenRenewed?.invoke(channelId, ok)
        }
    }

    /**
     * Leave the channel AND put the camera down.
     *
     * ── THE CAMERA THAT NEVER TURNED OFF ─────────────────────────────────────
     *
     * `setupLocalVideo` calls `startPreview()`, and nothing outside
     * `useAudioOnly` ever called `stopPreview()`. `release()` — which does
     * destroy the engine — had no caller anywhere in the app. So every video
     * call and every visit to Go Live left the capture running for the rest of
     * the process: the operating system's camera indicator stayed lit, the
     * battery drained, the device warmed, and the next screen that wanted the
     * camera could be refused it by the one nobody had released.
     *
     * Stopping the preview here rather than only in `release()` is deliberate:
     * leaving a channel is the moment a person stops broadcasting, whether or
     * not the screen is being destroyed, and the camera should go down with the
     * broadcast. `startPreview()` is idempotent, so re-entering a room brings
     * it straight back.
     */
    fun leaveChannel() {
        engine?.stopPreview()
        engine?.leaveChannel()
        joinedChannel = ""
        lastJoin = null
        renewJob?.cancel()
        renewJob = null
    }

    // ── Party rooms ──────────────────────────────────────────────────────────
    //
    // A party is the one place in this app where a person's role changes while
    // they are in the channel: a listener taps an empty seat and has to start
    // publishing, and a seat holder stands up and has to stop. Doing that by
    // leaving and rejoining costs the better part of a second of silence, which
    // in a room of nine people reads as the app breaking rather than as somebody
    // sitting down. Agora can change the role in place, and that is what
    // [setPartyRole] is for.

    /**
     * Join a party channel.
     *
     * [video] is false for [com.zipper.app.data.model.PartyRoom.MODE_AUDIO], and
     * that is not a cosmetic difference. With video enabled the engine brings up
     * the capture pipeline and the encoder whether or not anything is published,
     * and on the phones this app is shipped to — the ₹8,000 Android in Dhaka or
     * Kathmandu — that is the difference between an audio room that runs cool
     * for two hours and one that throttles and drains.
     *
     * [uid] must be the Agora uid this user will publish on, and for a seat
     * holder that is their seat index, because `takePartySeat` writes
     * `agoraUid = seatIndex` and every other client binds that seat's tile to
     * it. 0 for the host and for listeners: the host's tile is found by
     * elimination (see PartyRoomViewModel) and a listener publishes nothing.
     */
    fun joinPartyChannel(
        channelId: String,
        token: String? = null,
        uid: Int = 0,
        asBroadcaster: Boolean = false,
        video: Boolean = false,
    ) {
        val eng = engine ?: return
        if (video) useVideo() else useAudioOnly()
        val role = if (asBroadcaster) Constants.CLIENT_ROLE_BROADCASTER else Constants.CLIENT_ROLE_AUDIENCE
        eng.setClientRole(role)
        val options = {
            ChannelMediaOptions().apply {
                clientRoleType = role
                channelProfile = Constants.CHANNEL_PROFILE_LIVE_BROADCASTING
                publishMicrophoneTrack = asBroadcaster
                publishCameraTrack = asBroadcaster && video
                autoSubscribeAudio = true
                autoSubscribeVideo = video
            }
        }
        eng.joinChannel(token, channelId, uid, options())
        joinedChannel = channelId
        lastJoin = JoinSpec(channelId, uid, role, options)
    }

    /**
     * Change role without leaving the channel.
     *
     * `updateChannelMediaOptions` only touches the fields set on the options
     * object, so the token, the uid and every subscription survive; the user
     * hears the room continuously across sitting down and standing up.
     */
    fun setPartyRole(asBroadcaster: Boolean, video: Boolean) {
        val eng = engine ?: return
        val role = if (asBroadcaster) Constants.CLIENT_ROLE_BROADCASTER else Constants.CLIENT_ROLE_AUDIENCE
        eng.setClientRole(role)
        val options = ChannelMediaOptions().apply {
            clientRoleType = role
            publishMicrophoneTrack = asBroadcaster
            publishCameraTrack = asBroadcaster && video
        }
        eng.updateChannelMediaOptions(options)
        // Keep the recovery replay honest about the role we now hold.
        lastJoin = lastJoin?.let { spec ->
            spec.copy(role = role, options = {
                spec.options().apply {
                    clientRoleType = role
                    publishMicrophoneTrack = asBroadcaster
                    publishCameraTrack = asBroadcaster && video
                }
            })
        }
    }

    /**
     * Rejoin under a different Agora uid.
     *
     * The unavoidable case: a listener in a VIDEO room takes a seat. The server
     * has already written `agoraUid = seatIndex` on that seat, every other
     * client binds the tile to that uid, and a client cannot change its uid
     * while in a channel. Publishing on the uid we happened to join with would
     * leave four other phones rendering a black rectangle.
     *
     * Audio rooms never come through here — there is nothing to bind a stream
     * to, so the in-place [setPartyRole] is both correct and silent.
     */
    fun rejoinPartyAs(channelId: String, token: String?, uid: Int, video: Boolean) {
        val eng = engine ?: return
        eng.leaveChannel()
        joinPartyChannel(channelId, token, uid, asBroadcaster = true, video = video)
    }

    /**
     * Report who is speaking, every [intervalMs].
     *
     * 400ms is slow enough to be nearly free and fast enough that a ring lights
     * on the syllable rather than after it. Turn it off on the way out: it is a
     * callback several times a second that the live and call screens have no use
     * for, and the engine outlives the party screen.
     */
    fun enableSpeakingIndicator(enabled: Boolean, intervalMs: Int = 400) {
        engine?.enableAudioVolumeIndication(if (enabled) intervalMs else 0, 3, false)
    }

    /**
     * Drop the video subsystem. Paired with [useVideo]; see [audioOnly].
     */
    private fun useAudioOnly() {
        val eng = engine ?: return
        if (audioOnly) return
        eng.stopPreview()
        eng.disableVideo()
        eng.enableAudio()
        audioOnly = true
    }

    /** Undo [useAudioOnly]. Safe to call when video was never switched off. */
    fun useVideo() {
        val eng = engine ?: return
        if (!audioOnly) return
        eng.enableVideo()
        audioOnly = false
    }

    fun setupLocalVideo(surfaceView: SurfaceView) {
        val canvas = VideoCanvas(surfaceView, VideoCanvas.RENDER_MODE_HIDDEN, 0)
        engine?.setupLocalVideo(canvas)
        engine?.startPreview()
    }

    fun setupRemoteVideo(surfaceView: SurfaceView, remoteUid: Int) {
        val canvas = VideoCanvas(surfaceView, VideoCanvas.RENDER_MODE_HIDDEN, remoteUid)
        engine?.setupRemoteVideo(canvas)
    }

    /**
     * Stop capturing, without tearing the engine down.
     *
     * The engine is a process-wide singleton shared by live, calls and party
     * rooms, so a screen that is finished with the camera must be able to put
     * it down without destroying something the next screen needs.
     */
    fun stopPreview() { engine?.stopPreview() }

    fun muteLocalAudio(mute: Boolean) { engine?.muteLocalAudioStream(mute) }

    /**
     * The viewer's stream-quality choice, applied to the host's video.
     *   Auto — the main stream, falling back to the low stream when the link is weak;
     *   High — always the main stream;   Low — always the low stream.
     * Has an effect only on a host whose app publishes the low stream (above).
     */
    fun setRemoteQuality(remoteUid: Int, quality: String) {
        val eng = engine ?: return
        val type = if (quality == "Low") Constants.VIDEO_STREAM_LOW else Constants.VIDEO_STREAM_HIGH
        runCatching {
            eng.setRemoteSubscribeFallbackOption(if (quality == "Auto") Constants.STREAM_FALLBACK_OPTION_VIDEO_STREAM_LOW else Constants.STREAM_FALLBACK_OPTION_DISABLED)
            eng.setRemoteDefaultVideoStreamType(type)
            if (remoteUid != 0) eng.setRemoteVideoStreamType(remoteUid, type)
        }
    }
    fun muteLocalVideo(mute: Boolean) { engine?.muteLocalVideoStream(mute) }
    fun switchCamera() { engine?.switchCamera() }

    fun release() {
        engine?.leaveChannel()
        RtcEngine.destroy()
        engine = null
        audioOnly = false
        onAudioVolume = null
        lastJoin = null
        renewJob?.cancel()
        renewJob = null
        tokenRenewer = null
        onTokenRenewed = null
        /*
         * Clear the membership too, or `isInChannel` lies about a destroyed engine.
         *
         * `leaveChannel()` resets this and `release()` did not, so after a release
         * the tracker still named a channel nobody was in — and the PK join, whose
         * whole purpose is to skip a redundant rejoin, would skip the one it
         * actually needed to make. The host would stay off the battle channel with
         * no error anywhere.
         */
        joinedChannel = ""
    }
}
