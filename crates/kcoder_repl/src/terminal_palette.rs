use crate::terminal_probe;
use std::sync::{Mutex, OnceLock};

pub(crate) fn default_bg() -> Option<(u8, u8, u8)> {
    default_colors().map(|colors| colors.bg)
}

fn default_colors() -> Option<terminal_probe::DefaultColors> {
    let mut cache = default_colors_cache().lock().ok()?;
    cache.get_or_init_with(query_default_colors)
}

fn query_default_colors() -> Option<terminal_probe::DefaultColors> {
    #[cfg(test)]
    {
        None
    }

    #[cfg(not(test))]
    {
        terminal_probe::default_colors(terminal_probe::DEFAULT_TIMEOUT)
            .ok()
            .flatten()
    }
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn set_default_colors_from_startup_probe(colors: Option<terminal_probe::DefaultColors>) {
    if let Ok(mut cache) = default_colors_cache().lock() {
        cache.set_attempted_value(colors);
    }
}

fn default_colors_cache() -> &'static Mutex<Cache<terminal_probe::DefaultColors>> {
    static COLORS: OnceLock<Mutex<Cache<terminal_probe::DefaultColors>>> = OnceLock::new();
    COLORS.get_or_init(|| Mutex::new(Cache::default()))
}

#[derive(Debug)]
struct Cache<T> {
    attempted: bool,
    value: Option<T>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self {
            attempted: false,
            value: None,
        }
    }
}

impl<T: Copy> Cache<T> {
    fn get_or_init_with(&mut self, mut init: impl FnMut() -> Option<T>) -> Option<T> {
        if !self.attempted {
            self.value = init();
            self.attempted = true;
        }
        self.value
    }

    fn set_attempted_value(&mut self, value: Option<T>) {
        self.value = value;
        self.attempted = true;
    }

    #[allow(dead_code)] // exercised by tests below; production caller was removed.
    fn requery_with(&mut self, mut query: impl FnMut() -> Option<T>) {
        if self.attempted && self.value.is_none() {
            return;
        }
        self.value = query();
        self.attempted = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_initializes_only_once() {
        let mut cache = Cache::default();
        let mut calls = 0;

        assert_eq!(
            cache.get_or_init_with(|| {
                calls += 1;
                Some(7)
            }),
            Some(7)
        );
        assert_eq!(
            cache.get_or_init_with(|| {
                calls += 1;
                Some(8)
            }),
            Some(7)
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn failed_startup_probe_prevents_a_second_lazy_query() {
        let mut cache: Cache<u8> = Cache::default();
        cache.set_attempted_value(None);
        assert_eq!(
            cache.get_or_init_with(|| panic!("startup已探测，不应在主题预热时再次查询")),
            None
        );
    }

    #[test]
    fn cache_requery_refreshes_existing_value() {
        let mut cache = Cache::default();
        cache.set_attempted_value(Some(1));

        cache.requery_with(|| Some(2));

        assert_eq!(cache.value, Some(2));
        assert!(cache.attempted);
    }

    #[test]
    fn cache_requery_skips_after_failed_attempt() {
        let mut cache: Cache<u8> = Cache::default();
        assert_eq!(cache.get_or_init_with(|| None), None);
        let mut calls = 0;

        cache.requery_with(|| {
            calls += 1;
            Some(7)
        });

        assert_eq!(calls, 0);
        assert_eq!(cache.value, None);
        assert!(cache.attempted);
    }
}
