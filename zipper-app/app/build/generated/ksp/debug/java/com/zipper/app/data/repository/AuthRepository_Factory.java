package com.zipper.app.data.repository;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.storage.FirebaseStorage;
import dagger.internal.DaggerGenerated;
import dagger.internal.Factory;
import dagger.internal.QualifierMetadata;
import dagger.internal.ScopeMetadata;
import javax.annotation.processing.Generated;
import javax.inject.Provider;

@ScopeMetadata("javax.inject.Singleton")
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
public final class AuthRepository_Factory implements Factory<AuthRepository> {
  private final Provider<FirebaseAuth> authProvider;

  private final Provider<FirebaseFirestore> firestoreProvider;

  private final Provider<FirebaseStorage> storageProvider;

  public AuthRepository_Factory(Provider<FirebaseAuth> authProvider,
      Provider<FirebaseFirestore> firestoreProvider, Provider<FirebaseStorage> storageProvider) {
    this.authProvider = authProvider;
    this.firestoreProvider = firestoreProvider;
    this.storageProvider = storageProvider;
  }

  @Override
  public AuthRepository get() {
    return newInstance(authProvider.get(), firestoreProvider.get(), storageProvider.get());
  }

  public static AuthRepository_Factory create(Provider<FirebaseAuth> authProvider,
      Provider<FirebaseFirestore> firestoreProvider, Provider<FirebaseStorage> storageProvider) {
    return new AuthRepository_Factory(authProvider, firestoreProvider, storageProvider);
  }

  public static AuthRepository newInstance(FirebaseAuth auth, FirebaseFirestore firestore,
      FirebaseStorage storage) {
    return new AuthRepository(auth, firestore, storage);
  }
}
