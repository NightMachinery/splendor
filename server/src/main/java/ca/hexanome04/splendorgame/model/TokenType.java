package ca.hexanome04.splendorgame.model;

/**
 * Enum representing the types of tokens.
 */
public enum TokenType {

    /**
     * Green token.
     */
    Green,

    /**
     * White token.
     */
    White,

    /**
     * Blue token.
     */
    Blue,

    /**
     * Brown token.
     */
    Brown,

    /**
     * Red token.
     */
    Red,

    /**
     * Satchel token.
     */
    Satchel,

    /**
     * Gold token.
     */
    Gold;

    /**
     * Whether this is one of the five gem colours, as opposed to Gold or the Satchel placeholder.
     *
     * @return true for Green, White, Blue, Brown and Red
     */
    public boolean isGem() {
        return this != Satchel && this != Gold;
    }
}
