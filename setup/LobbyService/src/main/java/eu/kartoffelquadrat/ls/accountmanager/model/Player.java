package eu.kartoffelquadrat.ls.accountmanager.model;

import javax.persistence.*;

/**
 * Database entity for persisted players. The name serves as id (primary key). Remaining fields must not be null.
 *
 * @author Maximilian Schiedermeier, August 2020
 */
@Entity
public class Player {

    @Id
    private String name;

    private String password; // The password is internally hashed. No plain passwords are stored upon persistence.

    private String preferredColour;

    @Column(unique = true)
    private String authToken;

    private String displayName;

    @Enumerated(EnumType.STRING)
    private Role role;

    /**
     * Default constructor is required for JSON de/serialization.
     */
    public Player()
    {}

    /**
     * Player constructor.
     */
    public Player(String name, String preferredColour, String password, Role role) {
        this.name = name;
        this.preferredColour = preferredColour;
        this.password = password;
        this.role = role;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public String getPreferredColour() {
        return preferredColour;
    }

    public void setPreferredColour(String preferredColour) {
        this.preferredColour = preferredColour;
    }

    public String getAuthToken() {
        return authToken;
    }

    public void setAuthToken(String authToken) {
        this.authToken = authToken;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public Role getRole() {
        return role;
    }

    public void setRole(Role role) {
        this.role = role;
    }
}
