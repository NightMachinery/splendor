package ca.hexanome04.splendorgame.model.action;

import ca.hexanome04.splendorgame.model.SplendorException;
import ca.hexanome04.splendorgame.model.TokenType;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Strict helpers for reading action request bodies.
 * Every problem is reported as a {@link SplendorException} whose message says which field is wrong,
 * so that the REST layer can answer with a 400 and a useful explanation.
 */
public final class ActionJson {

    /**
     * Largest token amount accepted in a request (anything above 10 can never be legal anyway).
     */
    private static final int MAX_AMOUNT = 100;

    private ActionJson() {
    }

    /**
     * Read a required, non-blank string field.
     *
     * @param obj request body
     * @param key field name
     * @return field value
     */
    public static String requireString(JsonObject obj, String key) {
        JsonElement element = obj == null ? null : obj.get(key);
        if (element == null || element.isJsonNull()) {
            throw new SplendorException("Missing field '" + key + "'.");
        }
        if (!element.isJsonPrimitive()) {
            throw new SplendorException("Field '" + key + "' must be a string.");
        }
        String value = element.getAsString();
        if (value.isBlank()) {
            throw new SplendorException("Field '" + key + "' must not be empty.");
        }
        return value;
    }

    /**
     * Read an optional token type field.
     *
     * @param obj request body
     * @param key field name
     * @return token type, or null when the field is absent or null
     */
    public static TokenType optionalTokenType(JsonObject obj, String key) {
        JsonElement element = obj == null ? null : obj.get(key);
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (!element.isJsonPrimitive()) {
            throw new SplendorException("Field '" + key + "' must be a token name.");
        }
        return parseTokenType(element.getAsString(), key);
    }

    /**
     * Read a required token type field.
     *
     * @param obj request body
     * @param key field name
     * @return token type
     */
    public static TokenType requireTokenType(JsonObject obj, String key) {
        TokenType type = optionalTokenType(obj, key);
        if (type == null) {
            throw new SplendorException("Missing field '" + key + "'.");
        }
        return type;
    }

    /**
     * Read a map of token amounts, such as {"Red": 1, "Blue": 2}.
     * Amounts must be whole numbers between 0 and 100.
     *
     * @param obj request body
     * @param key field name
     * @param required whether a missing field is an error (otherwise an empty map is returned)
     * @return token amounts (only the token types present in the request)
     */
    public static HashMap<TokenType, Integer> tokenAmounts(JsonObject obj, String key, boolean required) {
        HashMap<TokenType, Integer> amounts = new HashMap<>();
        JsonElement element = obj == null ? null : obj.get(key);
        if (element == null || element.isJsonNull()) {
            if (required) {
                throw new SplendorException("Missing field '" + key + "'.");
            }
            return amounts;
        }
        if (!element.isJsonObject()) {
            throw new SplendorException("Field '" + key + "' must be an object such as {\"Red\": 1}.");
        }

        for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
            TokenType type = parseTokenType(entry.getKey(), key);
            amounts.put(type, parseAmount(key + "." + entry.getKey(), entry.getValue()));
        }
        return amounts;
    }

    private static TokenType parseTokenType(String name, String field) {
        for (TokenType type : TokenType.values()) {
            if (type.name().equals(name)) {
                return type;
            }
        }
        throw new SplendorException("Unknown token type '" + name + "' in field '" + field + "'. Valid types: "
                + Arrays.toString(TokenType.values()) + ".");
    }

    private static int parseAmount(String field, JsonElement value) {
        if (value == null || !value.isJsonPrimitive()) {
            throw new SplendorException("Amount for '" + field + "' must be a whole number.");
        }
        JsonPrimitive primitive = value.getAsJsonPrimitive();
        if (primitive.isBoolean()) {
            throw new SplendorException("Amount for '" + field + "' must be a whole number.");
        }
        BigDecimal number;
        try {
            number = primitive.getAsBigDecimal();
        } catch (NumberFormatException e) {
            throw new SplendorException("Amount for '" + field + "' must be a whole number.");
        }
        if (number.signum() < 0) {
            throw new SplendorException("Amount for '" + field + "' must not be negative.");
        }
        if (number.stripTrailingZeros().scale() > 0) {
            throw new SplendorException("Amount for '" + field + "' must be a whole number.");
        }
        if (number.compareTo(BigDecimal.valueOf(MAX_AMOUNT)) > 0) {
            throw new SplendorException("Amount for '" + field + "' is too large.");
        }
        return number.intValueExact();
    }

}
