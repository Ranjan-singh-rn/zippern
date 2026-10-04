package com.zipper.app.ui.screens.live

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.model.LiveRoom
import com.zipper.app.data.model.User
import com.zipper.app.data.repository.LiveRepository
import com.zipper.app.data.repository.ProfileRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LiveBrowseUiState(
    val rooms: List<LiveRoom> = emptyList(),
    val currentUser: User? = null,
    val isLoading: Boolean = true,
    val selectedCategory: String = "all",
)

@HiltViewModel
class LiveBrowseViewModel @Inject constructor(
    private val repo: LiveRepository,
    private val profileRepo: ProfileRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LiveBrowseUiState())
    val state: StateFlow<LiveBrowseUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            repo.liveRoomsFlow().collect { rooms ->
                _state.update { it.copy(rooms = rooms, isLoading = false) }
            }
        }
        viewModelScope.launch {
            profileRepo.currentUserFlow().collect { user ->
                _state.update { it.copy(currentUser = user) }
            }
        }
    }

    fun selectCategory(category: String) {
        _state.update { it.copy(selectedCategory = category) }
    }
}
