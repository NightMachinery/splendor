package ca.hexanome04.splendorgame.model;

import static org.assertj.core.api.Assertions.assertThat;

import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesGame;
import ca.hexanome04.splendorgame.model.gameversions.cities.CitiesPlayer;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientGame;
import ca.hexanome04.splendorgame.model.gameversions.orient.OrientPlayer;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsGame;
import ca.hexanome04.splendorgame.model.gameversions.tradingposts.TradingPostsPlayer;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Gson loads a save by setting every field of the game reflectively. JDK 26 warns when such a field
 * is final, and a later JDK will refuse (JEP 500), which would break loading every save. The
 * Maven profile for JDK 26 and later makes the tests refuse it already; this test catches a new
 * final field on older JDKs too, such as CI's JDK 17.
 */
public class SavedStateFieldsTest {

    private static final String OUR_PACKAGE = "ca.hexanome04.splendorgame.";

    /** The games, plus the subtypes that Gson picks from a "type" property (see SplendorTypeAdapter). */
    private static final List<Class<?>> ROOTS = List.of(
            OrientGame.class, CitiesGame.class, TradingPostsGame.class,
            OrientPlayer.class, CitiesPlayer.class, TradingPostsPlayer.class,
            RegDevelopmentCard.class, OrientDevelopmentCard.class);

    private static void addTypes(Type type, Deque<Class<?>> out) {
        if (type instanceof Class<?> c) {
            out.add(c.isArray() ? c.getComponentType() : c);
        } else if (type instanceof ParameterizedType p) {
            addTypes(p.getRawType(), out);
            for (Type arg : p.getActualTypeArguments()) {
                addTypes(arg, out);
            }
        } else if (type instanceof GenericArrayType a) {
            addTypes(a.getGenericComponentType(), out);
        } else if (type instanceof TypeVariable<?> v) {
            for (Type bound : v.getBounds()) {
                addTypes(bound, out);
            }
        } else if (type instanceof WildcardType w) {
            for (Type bound : w.getUpperBounds()) {
                addTypes(bound, out);
            }
        }
    }

    @Test
    @DisplayName("No field that Gson sets when loading a save is final")
    void testSavedFieldsAreNotFinal() {
        Deque<Class<?>> todo = new ArrayDeque<>(ROOTS);
        Set<Class<?>> seen = new HashSet<>();
        List<String> finalFields = new ArrayList<>();
        while (!todo.isEmpty()) {
            Class<?> c = todo.poll();
            if (!c.getName().startsWith(OUR_PACKAGE) || c.isEnum() || !seen.add(c)) {
                continue;
            }
            if (c.getSuperclass() != null) {
                todo.add(c.getSuperclass());
            }
            for (Field f : c.getDeclaredFields()) {
                int mod = f.getModifiers();
                // Gson skips static and transient fields
                if (Modifier.isStatic(mod) || Modifier.isTransient(mod) || f.isSynthetic()) {
                    continue;
                }
                if (Modifier.isFinal(mod)) {
                    finalFields.add(c.getSimpleName() + "." + f.getName());
                }
                addTypes(f.getGenericType(), todo);
            }
        }

        // the walk must reach the saved state, or the check proves nothing
        assertThat(seen).contains(Deck.class, Card.class, NobleCard.class, Player.class);
        assertThat(finalFields).isEmpty();
    }
}
