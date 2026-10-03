pub fn answer() -> u32 {
    42
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_answer() {
        assert_eq!(answer(), 42);
    }
}
