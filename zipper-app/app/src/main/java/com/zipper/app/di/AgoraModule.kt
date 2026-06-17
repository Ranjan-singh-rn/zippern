package com.zipper.app.di

import android.content.Context
import com.zipper.app.BuildConfig
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.agora.rtc2.RtcEngine
import io.agora.rtc2.RtcEngineConfig
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AgoraModule {

    @Provides
    @Singleton
    fun provideAgoraEngine(@ApplicationContext context: Context): RtcEngine {
        val config = RtcEngineConfig().apply {
            mAppId = BuildConfig.AGORA_APP_ID
            mContext = context
            mEventHandler = null // Individual screens attach their own handlers
        }
        return RtcEngine.create(config)
    }
}
