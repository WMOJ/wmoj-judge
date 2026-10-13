// What a real solution leans on and a hello-world does not: recursion a
// million frames deep (the 64 MB -Xss, which the default 1 MB stack turns
// into StackOverflowError) and 150 MB of live heap under a 256 MB limit
// (inside the 192 MB -Xmx, so this must be AC, not MLE).
import java.util.Scanner;

public class Main {
    static long depth(int n) {
        return n == 0 ? 0 : 1 + depth(n - 1);
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        long[][] held = new long[150][];
        long sum = 0;
        for (int i = 0; i < held.length; i++) {
            held[i] = new long[1 << 17];
            held[i][i] = i;
            sum += held[i][i];
        }
        System.out.println(depth(n) + " " + sum);
    }
}
