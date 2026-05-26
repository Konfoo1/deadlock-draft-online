#!/usr/bin/env python3
"""Deadlock Custom Draft Tool — Standalone Desktop Application.

A Tkinter-based GUI application that facilitates hero drafting for Deadlock
custom games. Two teams alternate banning and picking heroes in a structured
snake-draft format. Each team bans 3 heroes and picks 3 heroes, then the
winning pick is chosen unanimously by the team (all 6 players play that hero).

Draft Order:
    Ban Phase:  Team A ban -> Team B ban -> Team A ban -> Team B ban ->
                Team A ban -> Team B ban
    Pick Phase: Team A pick -> Team B pick -> Team A pick -> Team B pick ->
                Team A pick -> Team B pick

Usage:
    Run directly::

        python deadlock_draft.py

    Package as a standalone executable::

        pip install pyinstaller
        pyinstaller --onefile --windowed deadlock_draft.py

Attributes:
    HEROES (list[str]): Sorted list of all available hero names. Update this
        list to match the latest game patch.
    BG (str): Hex color code for the main application background.
    PANEL_BG (str): Hex color code for team panel backgrounds.
    TEAM_A_COLOR (str): Primary hex color for Team A (red).
    TEAM_B_COLOR (str): Primary hex color for Team B (teal).
    TEAM_A_LIGHT (str): Light accent hex color for Team A.
    TEAM_B_LIGHT (str): Light accent hex color for Team B.
    BAN_COLOR (str): Hex color for banned hero indicators.
    TEXT_COLOR (str): Hex color for standard UI text.
    HOVER_COLOR (str): Hex color for button hover states.
    DISABLED_FG (str): Hex color for disabled/placeholder text.
    GOLD (str): Hex color for the draft prompt and completion text.
    HERO_BTN_BG (str): Hex color for hero button backgrounds.
    HERO_BTN_FG (str): Hex color for hero button text.
    DRAFT_ORDER (list[tuple[int, str]]): Sequence of ``(team_index, action)``
        tuples defining the draft turn order. ``team_index`` is 0 for Team A
        and 1 for Team B; ``action`` is either ``"BAN"`` or ``"PICK"``.
"""

import tkinter as tk
from tkinter import font as tkfont
import random

# ─── Hero Roster (edit this list to match the latest patch) ─────────────────
HEROES = sorted([
    "Abrams", "Bebop", "Calico", "Celeste", "Drifter", "Dynamo",
    "Graves", "Grey Talon", "Haze", "Holliday", "Infernus",
    "Ivy", "Kelvin", "Lady Geist", "Lash", "McGinnis", "Mina",
    "Mirage", "Mo & Krill", "Paradox", "Pocket", "Rem", "Seven",
    "Shiv", "Sinclair", "Silver", "Venator", "Vindicta", "Viscous",
    "Vyper", "Warden", "Wraith", "Yamato",
])

# ─── Color Palette ──────────────────────────────────────────────────────────
BG            = "#1a1a2e"
PANEL_BG      = "#16213e"
TEAM_A_COLOR  = "#e94560"
TEAM_B_COLOR  = "#0f9b8e"
TEAM_A_LIGHT  = "#ff6b81"
TEAM_B_LIGHT  = "#2ed8c3"
BAN_COLOR     = "#444444"
TEXT_COLOR     = "#eaeaea"
HOVER_COLOR   = "#2a2a4a"
DISABLED_FG   = "#666666"
GOLD          = "#f5c518"
HERO_BTN_BG   = "#1f2b47"
HERO_BTN_FG   = "#d0d0d0"

# ─── Draft Sequence ─────────────────────────────────────────────────────────
# Each entry is (team_index, action) where team_index 0 = Team A, 1 = Team B.
DRAFT_ORDER = [
    (0, "BAN"),  (1, "BAN"),
    (0, "BAN"),  (1, "BAN"),
    (0, "BAN"),  (1, "BAN"),
    (0, "PICK"), (1, "PICK"),
    (0, "PICK"), (1, "PICK"),
    (0, "PICK"), (1, "PICK"),
]


class DraftApp(tk.Tk):
    """Main application window for the Deadlock Draft Tool.

    This class manages the complete draft lifecycle including the UI layout,
    draft state machine, and user interactions. It extends ``tk.Tk`` to serve
    as the root Tkinter window.

    Attributes:
        team_names (list[str]): Display names for each team, editable by users.
        team_colors (list[str]): Primary color hex codes for each team.
        team_lights (list[str]): Light accent color hex codes for each team.
        bans (list[list[str]]): Banned heroes per team.
            ``bans[0]`` contains Team A's bans, ``bans[1]`` contains Team B's.
        picks (list[list[str]]): Picked heroes per team.
            ``picks[0]`` contains Team A's picks, ``picks[1]`` contains Team B's.
        step (int): Current position in the ``DRAFT_ORDER`` sequence.
            Ranges from 0 to ``len(DRAFT_ORDER)``.
        draft_done (bool): Whether the draft has completed all steps.
        hero_buttons (dict[str, tk.Button]): Mapping of hero names to their
            corresponding button widgets in the hero grid.
    """

    def __init__(self):
        """Initialize the DraftApp window, state, fonts, and UI components."""
        super().__init__()
        self.title("Deadlock Draft Tool")
        self.configure(bg=BG)
        self.minsize(1000, 680)
        self.resizable(True, True)

        # ── State ───────────────────────────────────────────────────────────
        self.team_names = ["Team Amber", "Team Jade"]
        self.team_colors = [TEAM_A_COLOR, TEAM_B_COLOR]
        self.team_lights = [TEAM_A_LIGHT, TEAM_B_LIGHT]
        self.bans  = [[], []]   # bans[0] = Team A bans, bans[1] = Team B bans
        self.picks = [[], []]
        self.step  = 0
        self.draft_done = False

        # ── Fonts ───────────────────────────────────────────────────────────
        self.title_font  = tkfont.Font(family="Segoe UI", size=20, weight="bold")
        self.header_font = tkfont.Font(family="Segoe UI", size=14, weight="bold")
        self.body_font   = tkfont.Font(family="Segoe UI", size=11)
        self.small_font  = tkfont.Font(family="Segoe UI", size=9)
        self.hero_font   = tkfont.Font(family="Segoe UI", size=10, weight="bold")

        self._build_ui()
        self._update_prompt()

    # ════════════════════════════════════════════════════════════════════════
    #  UI BUILDING
    # ════════════════════════════════════════════════════════════════════════

    def _build_ui(self):
        """Construct the complete application UI layout.

        Creates three main sections:
            - **Top bar**: Draft phase prompt and subtitle.
            - **Main area**: Three-column layout with Team A panel, hero
              selection grid, and Team B panel.
            - **Bottom bar**: Undo, Reset, and Randomize action buttons.
        """
        # ── Top bar ─────────────────────────────────────────────────────────
        top = tk.Frame(self, bg=BG)
        top.pack(fill="x", padx=16, pady=(14, 4))

        self.prompt_label = tk.Label(
            top, text="", font=self.title_font, fg=GOLD, bg=BG, anchor="center"
        )
        self.prompt_label.pack(fill="x")

        self.sub_label = tk.Label(
            top, text="", font=self.body_font, fg=TEXT_COLOR, bg=BG, anchor="center"
        )
        self.sub_label.pack(fill="x", pady=(2, 0))

        # ── Main area (3 columns: Team A | Hero Grid | Team B) ─────────────
        main = tk.Frame(self, bg=BG)
        main.pack(fill="both", expand=True, padx=12, pady=8)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(0, weight=1)

        self.panel_a = self._build_team_panel(main, 0)
        self.panel_a.grid(row=0, column=0, sticky="ns", padx=(0, 6))

        self.hero_frame = self._build_hero_grid(main)
        self.hero_frame.grid(row=0, column=1, sticky="nsew")

        self.panel_b = self._build_team_panel(main, 1)
        self.panel_b.grid(row=0, column=2, sticky="ns", padx=(6, 0))

        # ── Bottom bar ──────────────────────────────────────────────────────
        bot = tk.Frame(self, bg=BG)
        bot.pack(fill="x", padx=16, pady=(4, 12))

        self.undo_btn = tk.Button(
            bot, text="⟵  Undo", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._undo, state="disabled"
        )
        self.undo_btn.pack(side="left")

        self.reset_btn = tk.Button(
            bot, text="Reset Draft", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._reset
        )
        self.reset_btn.pack(side="left", padx=(10, 0))

        self.randomize_btn = tk.Button(
            bot, text="🎲  Randomize Remaining", font=self.body_font,
            bg="#333", fg=TEXT_COLOR, activebackground="#555",
            activeforeground="white", relief="flat", padx=14, pady=4,
            command=self._randomize
        )
        self.randomize_btn.pack(side="right")

    def _build_team_panel(self, parent, team_idx):
        """Build a team's side panel displaying bans and picks.

        Creates a fixed-width panel containing an editable team name field,
        a bans section (3 slots), and a picks section (3 slots). Slot labels
        are stored as instance attributes for later updates.

        Args:
            parent: The parent Tkinter widget to attach the panel to.
            team_idx: Team index (0 for Team A, 1 for Team B).

        Returns:
            tk.Frame: The constructed team panel frame widget.
        """
        color = self.team_colors[team_idx]
        panel = tk.Frame(parent, bg=PANEL_BG, width=200, highlightbackground=color,
                         highlightthickness=2, padx=10, pady=10)
        panel.pack_propagate(False)
        panel.configure(width=210)

        # Name entry — allows live renaming of the team.
        name_frame = tk.Frame(panel, bg=PANEL_BG)
        name_frame.pack(fill="x", pady=(0, 6))

        name_entry = tk.Entry(
            name_frame, font=self.header_font, fg=color, bg="#0d1b30",
            insertbackground=color, relief="flat", justify="center"
        )
        name_entry.insert(0, self.team_names[team_idx])
        name_entry.pack(fill="x")
        name_entry.bind("<KeyRelease>", lambda e, i=team_idx: self._rename_team(e, i))

        if team_idx == 0:
            self.name_entry_a = name_entry
        else:
            self.name_entry_b = name_entry

        # Bans section — 3 label slots for banned heroes.
        tk.Label(panel, text="─── BANS ───", font=self.small_font,
                 fg=BAN_COLOR, bg=PANEL_BG).pack(pady=(8, 2))
        ban_frame = tk.Frame(panel, bg=PANEL_BG)
        ban_frame.pack(fill="x")

        ban_labels = []
        for i in range(3):
            lbl = tk.Label(ban_frame, text="—", font=self.body_font,
                           fg=DISABLED_FG, bg=PANEL_BG, anchor="center")
            lbl.pack(fill="x", pady=1)
            ban_labels.append(lbl)

        # Picks section — 3 label slots for picked heroes.
        tk.Label(panel, text="─── PICKS ───", font=self.small_font,
                 fg=self.team_lights[team_idx], bg=PANEL_BG).pack(pady=(14, 2))
        pick_frame = tk.Frame(panel, bg=PANEL_BG)
        pick_frame.pack(fill="x")

        pick_labels = []
        for i in range(3):
            lbl = tk.Label(pick_frame, text="—", font=self.body_font,
                           fg=DISABLED_FG, bg=PANEL_BG, anchor="center")
            lbl.pack(fill="x", pady=1)
            pick_labels.append(lbl)

        # Store label references for dynamic updates during the draft.
        if team_idx == 0:
            self.ban_labels_a  = ban_labels
            self.pick_labels_a = pick_labels
        else:
            self.ban_labels_b  = ban_labels
            self.pick_labels_b = pick_labels

        return panel

    def _build_hero_grid(self, parent):
        """Build the scrollable hero selection grid.

        Creates a canvas-based scrollable grid of hero buttons arranged in
        4 columns. Each button triggers ``_on_hero_click`` when pressed.
        Mouse wheel scrolling is supported.

        Args:
            parent: The parent Tkinter widget to attach the grid to.

        Returns:
            tk.Frame: The outer frame containing the canvas and scrollbar.
        """
        outer = tk.Frame(parent, bg=BG)

        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scrollbar = tk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        self.grid_inner = tk.Frame(canvas, bg=BG)

        self.grid_inner.bind(
            "<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=self.grid_inner, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Mouse-wheel scroll binding for the entire canvas.
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        self.hero_buttons = {}
        cols = 4
        for idx, hero in enumerate(HEROES):
            r, c = divmod(idx, cols)
            btn = tk.Button(
                self.grid_inner, text=hero, font=self.hero_font,
                bg=HERO_BTN_BG, fg=HERO_BTN_FG, activebackground=HOVER_COLOR,
                activeforeground="white", relief="flat", width=16, height=2,
                command=lambda h=hero: self._on_hero_click(h)
            )
            btn.grid(row=r, column=c, padx=4, pady=4, sticky="nsew")
            self.hero_buttons[hero] = btn

        for c in range(cols):
            self.grid_inner.columnconfigure(c, weight=1)

        return outer

    # ════════════════════════════════════════════════════════════════════════
    #  DRAFT LOGIC
    # ════════════════════════════════════════════════════════════════════════

    def _current_action(self):
        """Get the current draft step's team and action type.

        Returns:
            tuple[int | None, str | None]: A ``(team_index, action)`` tuple
                where ``team_index`` is 0 or 1 and ``action`` is ``"BAN"``
                or ``"PICK"``. Returns ``(None, None)`` if the draft is
                complete (all steps exhausted).
        """
        if self.step >= len(DRAFT_ORDER):
            return None, None
        return DRAFT_ORDER[self.step]

    def _used_heroes(self):
        """Collect all heroes that have been banned or picked by either team.

        Returns:
            set[str]: Set of hero names that are no longer available for
                selection in the draft.
        """
        used = set()
        for t in range(2):
            used.update(self.bans[t])
            used.update(self.picks[t])
        return used

    def _on_hero_click(self, hero):
        """Handle a hero button click during the draft.

        Validates the click against the current draft state. If valid,
        records the hero as a ban or pick for the active team and advances
        the draft to the next step.

        Args:
            hero: The name of the hero that was clicked.
        """
        if self.draft_done:
            return
        team_idx, action = self._current_action()
        if team_idx is None:
            return
        if hero in self._used_heroes():
            return

        if action == "BAN":
            self.bans[team_idx].append(hero)
        else:
            self.picks[team_idx].append(hero)

        self.step += 1
        self._refresh_all()

    def _undo(self):
        """Revert the most recent draft action.

        Decrements the step counter and removes the last ban or pick from
        the corresponding team. Has no effect if the draft is at step 0.
        """
        if self.step == 0:
            return
        self.step -= 1
        self.draft_done = False
        team_idx, action = DRAFT_ORDER[self.step]
        if action == "BAN":
            self.bans[team_idx].pop()
        else:
            self.picks[team_idx].pop()
        self._refresh_all()

    def _reset(self):
        """Reset the entire draft to its initial state.

        Clears all bans, picks, and resets the step counter to 0.
        """
        self.step = 0
        self.draft_done = False
        self.bans  = [[], []]
        self.picks = [[], []]
        self._refresh_all()

    def _randomize(self):
        """Fill all remaining draft steps with randomly selected heroes.

        Shuffles the pool of available (un-banned, un-picked) heroes and
        assigns them sequentially to the remaining draft steps, respecting
        the ban/pick action type for each step.
        """
        available = [h for h in HEROES if h not in self._used_heroes()]
        random.shuffle(available)
        while self.step < len(DRAFT_ORDER) and available:
            team_idx, action = DRAFT_ORDER[self.step]
            hero = available.pop()
            if action == "BAN":
                self.bans[team_idx].append(hero)
            else:
                self.picks[team_idx].append(hero)
            self.step += 1
        self._refresh_all()

    def _rename_team(self, event, team_idx):
        """Handle a team name change from the name entry field.

        Updates the internal team name and refreshes the prompt display.

        Args:
            event: The Tkinter ``KeyRelease`` event (unused but required
                by the binding signature).
            team_idx: Index of the team being renamed (0 or 1).
        """
        entry = self.name_entry_a if team_idx == 0 else self.name_entry_b
        self.team_names[team_idx] = entry.get() or f"Team {team_idx + 1}"
        self._update_prompt()

    # ════════════════════════════════════════════════════════════════════════
    #  REFRESH / RENDER
    # ════════════════════════════════════════════════════════════════════════

    def _refresh_all(self):
        """Refresh all UI elements to reflect the current draft state.

        Updates the prompt text, team panels, hero button states, and the
        undo button's enabled/disabled status.
        """
        self._update_prompt()
        self._update_panels()
        self._update_hero_buttons()
        self.undo_btn.configure(state="normal" if self.step > 0 else "disabled")

    def _update_prompt(self):
        """Update the top-bar prompt and subtitle text.

        Displays the current team's name and action (e.g., "Team Amber — BAN #2")
        during the draft, or a completion message with a summary of picks when
        the draft is finished.
        """
        team_idx, action = self._current_action()
        if team_idx is None:
            self.draft_done = True
            self.prompt_label.configure(text="✦  DRAFT COMPLETE  ✦", fg=GOLD)
            # Build a summary of each team's picks for the subtitle.
            summary_parts = []
            for t in range(2):
                picks_str = ", ".join(self.picks[t]) if self.picks[t] else "None"
                summary_parts.append(f"{self.team_names[t]}: {picks_str}")
            self.sub_label.configure(
                text=f"Each team votes on ONE of their 3 picks.  |  {summary_parts[0]}  |  {summary_parts[1]}"
            )
            self.randomize_btn.configure(state="disabled")
            return

        self.randomize_btn.configure(state="normal")
        team_name = self.team_names[team_idx]
        color = self.team_colors[team_idx]

        ban_count  = len(self.bans[team_idx])
        pick_count = len(self.picks[team_idx])

        if action == "BAN":
            self.prompt_label.configure(
                text=f"{team_name}  —  BAN #{ban_count + 1}", fg=color
            )
            self.sub_label.configure(text="Select a hero to ban from the pool.")
        else:
            self.prompt_label.configure(
                text=f"{team_name}  —  PICK #{pick_count + 1}", fg=color
            )
            self.sub_label.configure(text="Select a hero as a pick option for your team.")

    def _update_panels(self):
        """Refresh both team panels' ban and pick slot labels.

        Iterates over each team's ban and pick labels and updates their
        text and color to reflect the current draft state. Empty slots
        display a placeholder dash.
        """
        for t, (ban_labels, pick_labels) in enumerate([
            (self.ban_labels_a, self.pick_labels_a),
            (self.ban_labels_b, self.pick_labels_b),
        ]):
            for i, lbl in enumerate(ban_labels):
                if i < len(self.bans[t]):
                    lbl.configure(text=f"✕  {self.bans[t][i]}", fg="#cc4444")
                else:
                    lbl.configure(text="—", fg=DISABLED_FG)
            for i, lbl in enumerate(pick_labels):
                if i < len(self.picks[t]):
                    lbl.configure(text=f"★  {self.picks[t][i]}", fg=self.team_lights[t])
                else:
                    lbl.configure(text="—", fg=DISABLED_FG)

    def _update_hero_buttons(self):
        """Update the visual state of all hero buttons in the grid.

        Each button is styled based on its hero's draft status:
            - **Banned**: Dark red background, disabled, sunken relief.
            - **Picked**: Team-colored background, disabled, raised relief.
            - **Available**: Default styling, enabled, flat relief.
        """
        used = self._used_heroes()
        banned = set()
        for t in range(2):
            banned.update(self.bans[t])

        for hero, btn in self.hero_buttons.items():
            if hero in banned:
                btn.configure(bg="#2a1111", fg="#773333", state="disabled", relief="sunken")
            elif hero in used:
                # Hero has been picked — color the button with the picking team's color.
                team_idx = 0 if hero in self.picks[0] else 1
                btn.configure(
                    bg=self.team_colors[team_idx], fg="white",
                    state="disabled", relief="raised"
                )
            else:
                btn.configure(
                    bg=HERO_BTN_BG, fg=HERO_BTN_FG, state="normal", relief="flat"
                )


if __name__ == "__main__":
    app = DraftApp()
    app.mainloop()
