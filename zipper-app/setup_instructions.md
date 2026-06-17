# Setup Instructions

## Before opening in Android Studio

1. Copy your existing `google-services.json` into `app/` folder
2. Run in this folder:
   ```
   gradle wrapper --gradle-version 8.7
   ```
   OR let Android Studio download the wrapper automatically when you open the project.

## Opening the project

Open Android Studio -> File -> Open -> select the `zipper-app` folder (not the parent `zippern` folder).

## First sync

Android Studio will sync Gradle. It will download all dependencies (~500MB first time).

## Notes

- Agora App ID and Primary Certificate are in `app/build.gradle.kts` as buildConfigField
- All screens are placeholders — phases fill them in one by one
- The app compiles and runs showing placeholder screens
