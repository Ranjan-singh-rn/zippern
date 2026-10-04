package com.zipper.app.di

import android.content.Context
import android.util.Log
import com.zipper.app.BuildConfig
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.agora.rtc2.IRtcEngineEventHandler
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.RtcEngineConfig
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AgoraModule {

    @Provides
    @Singleton
    fun provideAgoraEngine(@ApplicationContext context: Context): RtcEngine? {
        return try {
            val config = RtcEngineConfig().apply {
                mAppId = BuildConfig.AGORA_APP_ID
                mContext = context
                // No-op handler at the module level; each screen registers its own
                // handler via addHandler() / removeHandler() as needed.
                mEventHandler = object : IRtcEngineEventHandler() {}
            }
            RtcEngine.create(config)
        } catch (e: Exception) {
            Log.e("AgoraModule", "RtcEngine.create() failed — live features disabled", e)
            null
        }
    }
}
