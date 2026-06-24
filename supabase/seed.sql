-- Example doors to get started. Edit names / pins / limits later in the dashboard.
-- GPIO pins match the wiring suggested in pi/README.md.

insert into public.doors (name, gpio_pin, open_threshold_seconds) values
    ('Blast Freezer 1', 17, 300),
    ('Blast Freezer 2', 22, 300),
    ('Blast Freezer 3', 27, 300)
on conflict (gpio_pin) do nothing;
