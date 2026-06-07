/**
 * Original source: http://websystique.com/spring-security/secure-spring-rest-api-using-oauth2/
 */
package eu.kartoffelquadrat.ls.accountmanager.config;

import eu.kartoffelquadrat.ls.accountmanager.controller.AuthTokenService;
import eu.kartoffelquadrat.ls.accountmanager.model.Player;
import java.util.Collections;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.common.OAuth2AccessToken;
import org.springframework.security.oauth2.common.exceptions.InvalidTokenException;
import org.springframework.security.oauth2.config.annotation.web.configuration.EnableResourceServer;
import org.springframework.security.oauth2.config.annotation.web.configuration.ResourceServerConfigurerAdapter;
import org.springframework.security.oauth2.config.annotation.web.configurers.ResourceServerSecurityConfigurer;
import org.springframework.security.oauth2.provider.OAuth2Authentication;
import org.springframework.security.oauth2.provider.OAuth2Request;
import org.springframework.security.oauth2.provider.token.ResourceServerTokenServices;
import org.springframework.security.oauth2.provider.token.TokenStore;

/**
 * Configuration to enable the possibility for role-based access protection for any url starting with /api/*.
 * @author Maximilian Schiedermeier, August 2020
 */
@Configuration
@EnableResourceServer
public class ResourceServerConfiguration extends ResourceServerConfigurerAdapter {

    private static final String RESOURCE_ID = "my_rest_api";

    @Autowired
    private TokenStore tokenStore;

    @Autowired
    private AuthTokenService authTokenService;

    @Override
    public void configure(ResourceServerSecurityConfigurer resources) {
        resources.resourceId(RESOURCE_ID).stateless(false).tokenServices(selfHostAwareTokenServices());
    }

    private ResourceServerTokenServices selfHostAwareTokenServices() {
        return new ResourceServerTokenServices() {
            @Override
            public OAuth2Authentication loadAuthentication(String accessToken) {
                Player player = authTokenService.resolve(accessToken);
                if (player != null) {
                    SimpleGrantedAuthority authority = new SimpleGrantedAuthority(player.getRole().toString());
                    UsernamePasswordAuthenticationToken userAuth = new UsernamePasswordAuthenticationToken(
                            player.getName(), accessToken, Collections.singletonList(authority));
                    OAuth2Request request = new OAuth2Request(Collections.emptyMap(), "self-host",
                            Collections.singletonList(authority), true, Collections.emptySet(),
                            Collections.singleton(RESOURCE_ID), null, Collections.emptySet(), Collections.emptyMap());
                    return new OAuth2Authentication(request, userAuth);
                }
                OAuth2Authentication authentication = tokenStore.readAuthentication(accessToken);
                if (authentication == null) {
                    throw new InvalidTokenException("Invalid access token: " + accessToken);
                }
                return authentication;
            }

            @Override
            public OAuth2AccessToken readAccessToken(String accessToken) {
                return tokenStore.readAccessToken(accessToken);
            }
        };
    }

    /**
     * The following ant matcher does not require any specific group affiliation for users who access /api/** prefixed
     * REST endpoints. However, it provides a security-context, which allows targeted overriding with additional group
     * requirements, by placing "@PreAuthorize("hasAuthority('ROLE_ADMIN')")"-annotations in front of REST access points
     * that require further access restrictions.
     * Note: Alternative role requirements can be be expressed with the following syntax:
     * @PreAuthorize("hasAuthority('ROLE_ADMIN') or hasAuthority('ROLE_USER')
     *
     * @param http
     * @throws Exception
     */
    @Override
    public void configure(HttpSecurity http) throws Exception {

        http.authorizeRequests()
                .antMatchers("/api/**")
                .permitAll(); // Allow by default all unauthenticated access to api. (Extra annotation required to delimit access based on roles.)
    }

}
