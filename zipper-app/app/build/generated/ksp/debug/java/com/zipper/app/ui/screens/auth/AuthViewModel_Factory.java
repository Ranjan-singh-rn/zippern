package com.zipper.app.ui.screens.auth;

import com.zipper.app.data.repository.AuthRepository;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata
@QualifierMetadata
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
public final class AuthViewModel_Factory implements Factory<AuthViewModel> {
  private final Provider<AuthRepository> repoProvider;

  public AuthViewModel_Factory(Provider<AuthRepository> repoProvider) {
    this.repoProvider = repoProvider;
  }

  @Override
  public AuthViewModel get() {
    return newInstance(repoProvider.get());
  }

  public static AuthViewModel_Factory create(Provider<AuthRepository> repoProvider) {
    return new AuthViewModel_Factory(repoProvider);
  }

  public static AuthViewModel newInstance(AuthRepository repo) {
    return new AuthViewModel(repo);
  }
}
