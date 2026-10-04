package com.zipper.app.data.model

data class LevelReward(
    val level: Int = 0,
    val diamondsRequired: Long = 0L,
    val beansRequired: Long = 0L,
    val rewardFrame: String = "",
    val rewardEntrance: String = "",
    val rewardProfileCard: String = "",
    val rewardVehicle: String = "",
    val entranceAsset: String = "",
    val rewardDiamonds: Long = 0L,
    val rewardBeans: Long = 0L,
)
