package com.zipper.app.di;

import android.content.Context;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.Preconditions;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import io.agora.rtc2.RtcEngine;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata("javax.inject.Singleton")
@QualifierMetadata("dagger.hilt.android.qualifiers.ApplicationContext")
@DaggerGenerated
@Generated(
    value = "dagger.internal.codegen.ComponentProcessor",
    comments = "https://dagger.dev"
)
@SuppressWarnings({
    "unchecked",
    "rawtypes",
    "KotlinInternal",
    "KotlinInternalInJava",
    "cast"
})
public final class AgoraModule_ProvideAgoraEngineFactory implements Factory<RtcEngine> {
  private final Provider<Context> contextProvider;

  public AgoraModule_ProvideAgoraEngineFactory(Provider<Context> contextProvider) {
    this.contextProvider = contextProvider;
  }

  @Override
  public RtcEngine get() {
    return provideAgoraEngine(contextProvider.get());
  }

  public static AgoraModule_ProvideAgoraEngineFactory create(Provider<Context> contextProvider) {
    return new AgoraModule_ProvideAgoraEngineFactory(contextProvider);
  }

  public static RtcEngine provideAgoraEngine(Context context) {
    return Preconditions.checkNotNullFromProvides(AgoraModule.INSTANCE.provideAgoraEngine(context));
  }
}
